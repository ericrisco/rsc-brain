"""The one vocabulary for a merge proposal's lifecycle (AUDIT-019 / R25).

There were three. The producer wrote ``needs_review`` and confirmed to ``applied``; the review queue
selected ``pending``; the console resolver confirmed to ``confirmed``. Nothing was wrong with any one
of those words — there were simply three sets of them, so a proposal a curator was meant to decide was
invisible in the console forever, and whichever code path wrote the row decided who was allowed to act
on it.

Defined here and imported everywhere, with a CHECK constraint behind it (see the
``proposal_status_vocabulary`` migration), because a shared constant is a convention and a constraint
is a guarantee: the next divergence fails at the write instead of hiding in a query.
"""

from __future__ import annotations

#: Waiting for a human. What the proposer writes and what the queue shows.
PROPOSAL_OPEN = "needs_review"
#: A human confirmed it and the merge was applied.
PROPOSAL_APPLIED = "applied"
#: Confidence cleared the auto-apply threshold; recorded for the audit trail, never queued.
PROPOSAL_AUTO_APPLIED = "auto_applied"
#: A human refused it. Terminal: the entities stay separate.
PROPOSAL_REJECTED = "rejected"

PROPOSAL_STATES = frozenset(
    {PROPOSAL_OPEN, PROPOSAL_APPLIED, PROPOSAL_AUTO_APPLIED, PROPOSAL_REJECTED}
)

#: Statuses that were written by earlier versions, mapped onto the vocabulary above. Kept as data so
#: the migration and any future repair share one answer about what an old row meant.
LEGACY_PROPOSAL_STATES = {"pending": PROPOSAL_OPEN, "confirmed": PROPOSAL_APPLIED}
