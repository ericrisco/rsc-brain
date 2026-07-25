"""Failed-login budgets, shared across replicas (AUDIT-038 / R09).

Two things had to change together, because either alone is theatre:

* **a budget.** ``login`` verified argon2id on every attempt, so brute force was bounded only by our
  own CPU cost — the attacker spends one request, we spend a hash. Over the threshold, expensive
  verification must not run at all.
* **uniform cost.** An unknown email returned before the verify, a known one after it. That
  difference is an account enumeration oracle measurable from outside no matter how identical the
  response body is, so an unknown account now pays the same hash against a dummy digest.

The counter lives in Postgres because the deployment runs several API replicas behind one proxy: an
in-memory limit is divided by however many replicas the attacker's requests land on. Each attempt
charges two budgets — the source network and the normalized account — with one atomic
upsert-and-return per budget, so concurrent replicas increment the same row instead of racing
separate ones.
"""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from rsc_brain.stores.relational import models
from rsc_brain.stores.relational.database import session_scope

#: Ratified defaults: a window, and how many failures either dimension may spend inside it.
WINDOW = dt.timedelta(minutes=15)
MAX_ATTEMPTS_PER_ACCOUNT = 10
MAX_ATTEMPTS_PER_NETWORK = 20


def normalize_account(email: str) -> str:
    """The account key. Case and surrounding space must not create a fresh budget."""
    return email.strip().casefold()


def _window_start(now: dt.datetime) -> dt.datetime:
    """Truncate to the window so every replica charges the same row for the same period."""
    seconds = int(WINDOW.total_seconds())
    epoch = int(now.timestamp()) // seconds * seconds
    return dt.datetime.fromtimestamp(epoch, tz=dt.UTC)


@dataclass(frozen=True, slots=True)
class BudgetState:
    """Whether the attempt may proceed, and how long to wait if not."""

    allowed: bool
    retry_after_seconds: int


class LoginBudget:
    def __init__(self, sessionmaker: async_sessionmaker[AsyncSession]) -> None:
        self._sm = sessionmaker

    async def check(self, *, network_key: str, account_key: str) -> BudgetState:
        """Whether either budget is already exhausted — read-only, charged nothing."""
        now = dt.datetime.now(dt.UTC)
        start = _window_start(now)
        async with self._sm() as session:
            rows = await session.execute(
                select(
                    models.LoginAttemptWindow.budget_key,
                    models.LoginAttemptWindow.attempts,
                ).where(
                    models.LoginAttemptWindow.window_start == start,
                    models.LoginAttemptWindow.budget_key.in_(
                        [f"network:{network_key}", f"account:{account_key}"]
                    ),
                )
            )
            spent: dict[str, int] = dict(rows.all())  # type: ignore[arg-type]
        over = (
            spent.get(f"account:{account_key}", 0) >= MAX_ATTEMPTS_PER_ACCOUNT
            or spent.get(f"network:{network_key}", 0) >= MAX_ATTEMPTS_PER_NETWORK
        )
        return BudgetState(
            allowed=not over,
            retry_after_seconds=int((start + WINDOW - now).total_seconds()) if over else 0,
        )

    async def charge_failure(self, *, network_key: str, account_key: str) -> None:
        """Charge one failed attempt to both budgets, atomically.

        ``ON CONFLICT DO UPDATE`` rather than read-then-write: two replicas handling the same burst
        would otherwise both read N and both write N+1, which is how a shared limit silently becomes a
        per-replica one.
        """
        start = _window_start(dt.datetime.now(dt.UTC))
        async with session_scope(self._sm) as session:
            for key in (f"network:{network_key}", f"account:{account_key}"):
                await session.execute(
                    pg_insert(models.LoginAttemptWindow)
                    .values(budget_key=key, window_start=start, attempts=1)
                    .on_conflict_do_update(
                        index_elements=["budget_key", "window_start"],
                        set_={"attempts": models.LoginAttemptWindow.attempts + 1},
                    )
                )

    async def clear(self, *, account_key: str) -> None:
        """Forget an account's failures after a success, so a legitimate user is not punished for
        having mistyped their password earlier in the window."""
        start = _window_start(dt.datetime.now(dt.UTC))
        async with session_scope(self._sm) as session:
            await session.execute(
                delete(models.LoginAttemptWindow).where(
                    models.LoginAttemptWindow.budget_key == f"account:{account_key}",
                    models.LoginAttemptWindow.window_start == start,
                )
            )
