"""AUDIT-101: the packaged ollama profile is CPU-only on macOS, and nothing said so.

Docker Desktop on macOS does not pass Metal through to a Linux container. So an operator on Apple
Silicon who starts the packaged `--profile ollama` service runs every model on CPU, however capable the
host is. Measured on an M4 Pro with 16 GPU cores, one 10-passage reranker call with `qwen2.5:3b-instruct`
— identical prompt and passages, only the serving route changed:

    ollama in the Compose profile   256.1 s     10/10 scores
    ollama native on the same host    5.2 s cold, 2.5 s warm

Against a 60 s default `timeout_s`, the first times out on every call and abstention silently falls
back (AUDIT-100). The second is not close to the limit. Same silicon, roughly 50-100x.

**Nothing lied, which is why it survived.** `brain doctor` reports `gpu=False` truthfully — from inside
the container there is none. The host's GPU is real and unreachable, and no surface connected those two
facts. The compose comment even said "a GPU is a host precondition (D8)", which reads as *provide a GPU
and this works* — true on Linux, false on the platform a lot of operators evaluate on.

The test closes the class: **wherever the packaged model server is offered, its platform limit is
stated.** A future file that offers the profile without the caveat fails here.
"""

from __future__ import annotations

from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

#: Files that either define the profile or tell an operator to start it.
OFFERS = (
    Path("deploy/docker-compose.prod.yml"),
    Path("deploy/docker-compose.version.yml"),
    Path("docker-compose.yml"),
    Path("deploy/README.md"),
    Path("docs/reference/configuration.md"),
)

#: Any of these counts as stating the limit — the point is that the reader is warned, not that a
#: particular word is used.
SIGNALS = ("Metal", "macos", "macOS", "host.docker.internal")


def _offers_the_profile(text: str) -> bool:
    return 'profiles: ["ollama"]' in text or "--profile ollama" in text or "profile ollama" in text


def test_at_least_one_shipped_file_offers_the_profile() -> None:
    """Precondition. Without it the loop below passes over nothing — the shape that let a docs gate
    go green over zero commands (AUDIT-086)."""
    offering = [
        p
        for p in OFFERS
        if (REPO / p).exists() and _offers_the_profile((REPO / p).read_text(encoding="utf-8"))
    ]
    assert offering, (
        "no shipped file offers the packaged ollama profile; the guard below is vacuous"
    )


def test_every_file_that_offers_the_profile_states_its_platform_limit() -> None:
    """The regression: the profile was offered in three places and its biggest limitation in none."""
    silent = []
    for rel in OFFERS:
        path = REPO / rel
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        if not _offers_the_profile(text):
            continue
        if not any(signal in text for signal in SIGNALS):
            silent.append(str(rel))
    assert not silent, (
        "these files tell an operator to start the packaged model server without saying that on macOS "
        "it gets no GPU — measured 256 s vs 2.5 s for the same call on the same machine:\n  "
        + "\n  ".join(silent)
    )
