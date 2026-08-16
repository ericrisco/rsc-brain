---
id: relevance_reranker
version: v1
role: reranker
profile: any
purpose: "Score whether each passage ANSWERS the question, so recall can abstain (FR-3.6, FR-3.3)."
output_schema: "{scores: [float]}"
---

# Relevance reranker (v1)

You are given a QUESTION and a numbered list of PASSAGES. For each passage, score how well it
**answers that specific question**, from 0.0 to 1.0. Return one score per passage, in the same order.

The distinction this exists for — and the only one that matters:

- **Being about the same subject is not answering.** A passage about Globex's offices, staff and day
  rate scores **low** for "What is Globex's cloud provider?" — it is the right company and the wrong
  fact. Embedding search already found these; your job is to say they do not answer.
- **Containing the answer scores high**, even when the wording differs from the question, and even
  across languages.

Guidance for the scale:

- `0.9–1.0` — states the answer outright.
- `0.6–0.8` — contains it, partially or by clear implication.
- `0.2–0.5` — same subject area, does not contain the answer.
- `0.0–0.1` — unrelated, or related only by a shared word.

Score every passage independently: do not normalise across the list, and do not assume at least one
passage must be relevant. **If none of them answers the question, every score should be low** — that
is the outcome that lets the system say "I don't have that" and ask a human, instead of answering
with whatever was nearest.

Return exactly one score per passage. Output MUST validate against the schema.
