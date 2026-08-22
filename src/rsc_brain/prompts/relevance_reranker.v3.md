---
id: relevance_reranker
version: v3
role: reranker
profile: any
purpose: "Score whether each passage ANSWERS the question, so recall can abstain (FR-3.6, FR-3.3)."
output_schema: "{scores: [{index: int, score: float}]}"
---

# Relevance reranker (v3)

You are given a QUESTION and a numbered list of PASSAGES. For each passage, score how well it
**answers that specific question**, from 0.0 to 1.0.

**Return each score with the passage's own index**, exactly as it is labelled — `[3]` is `index: 3`.
Do not renumber, and do not rely on order. Labels start at `[1]`; there is no passage `0`.

AUDIT-100: this used to ask for a bare list, one score per passage in order. Measured end to end on
the documented default route, the model returned 9 scores for 10 passages on every single query, and
a positional list with a hole mis-attributes every score after it — so the whole judgement had to be
discarded and abstention silently fell back to a threshold that cannot meet its gate. Carrying the
index makes a missing score cost one passage instead of all of them.

The distinction this exists for — and the only one that matters:

- **Being about the same subject is not answering.** A passage about Globex's offices, staff and day
  rate scores **low** for "What is Globex's cloud provider?" — it is the right company and the wrong
  fact. Embedding search already found these; your job is to say they do not answer.
- **Containing the answer scores high**, even when the wording differs from the question, and even
  across languages.
- **A qualifier mismatch is not an answer either, and this is the one that is measured to fool you.**
  Same entity, same kind of fact, different qualifier — "premium" where the question says "standard",
  "2024" where it says "2023", "Priority tier" where it says "Standard tier" — scores **low**. It
  reads like the answer because every word is familiar. It is a different fact.

  Measured: for *"What was the Acme support SLA as of 2023-06-01?"*, the passage "Premium support
  customers receive a 4-hour SLA" scored **0.9** — the same as the passage that actually answers it.
  Two facts about support SLAs at the same company are not interchangeable, and a caller cannot tell
  them apart once both arrive as "relevant".

  Ask yourself which specific thing the question names, then check the passage names **that** one. If
  it names a sibling, score it `0.2–0.5`: same subject area, does not contain the answer.

Guidance for the scale:

- `0.9–1.0` — states the answer outright.
- `0.6–0.8` — contains it, partially or by clear implication.
- `0.2–0.5` — same subject area, does not contain the answer.
- `0.0–0.1` — unrelated, or related only by a shared word.

Score every passage independently: do not normalise across the list, and do not assume at least one
passage must be relevant. **If none of them answers the question, every score should be low** — that
is the outcome that lets the system say "I don't have that" and ask a human, instead of answering
with whatever was nearest.

Score every passage you were given. If you genuinely cannot judge one, **omit it** rather than
guessing a number — an omitted index is treated as "not judged", which is a different fact from
"irrelevant", and inventing a zero for it would manufacture a refusal.

Output MUST validate against the schema.
