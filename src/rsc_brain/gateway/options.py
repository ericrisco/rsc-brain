"""Typed per-request generation options — the ONLY thing a caller may vary (AUDIT-005).

Routing (provider, model, endpoint, credentials, timeout, fallback) is owned by the
capability configuration and is *absent* from this object. Because the model forbids extra
fields, a caller literally cannot smuggle ``model``/``api_base``/``api_key`` through it.
"""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

# Upper bound so a caller cannot request an unbounded generation.
MAX_OUTPUT_TOKENS = 8192


class GenerationOptions(BaseModel):
    """Reviewed, bounded generation controls. Extra fields are rejected."""

    model_config = ConfigDict(frozen=True, extra="forbid")

    temperature: float | None = Field(default=None, ge=0.0, le=2.0)
    max_tokens: int | None = Field(default=None, gt=0, le=MAX_OUTPUT_TOKENS)
    top_p: float | None = Field(default=None, ge=0.0, le=1.0)

    def to_call_kwargs(self) -> dict[str, float | int]:
        """Only the set, allowlisted controls, ready to pass to the provider call."""
        raw: dict[str, float | int | None] = {
            "temperature": self.temperature,
            "max_tokens": self.max_tokens,
            "top_p": self.top_p,
        }
        return {k: v for k, v in raw.items() if v is not None}


#: AUDIT-102: every capability in this product extracts, judges or scores. None of them writes prose
#: — the retriever returns fragments and never synthesized text — so sampling buys nothing and costs
#: reproducibility. Measured: the reranker returned 0, then 9, then 0 scores for byte-identical input,
#: and `gemma4:12b` declares `temperature 1`. So ingesting a document twice could extract different
#: claims, and the abstention decision was a coin flip nobody could reproduce.
#:
#: Applied by the gateway, not by each caller, for the reason the codebase already gives elsewhere:
#: one place decides it, so a new call site cannot forget. `GenerationOptions` overrides it, which is
#: what it was always for — and nothing in the product had ever constructed one.
DETERMINISTIC = 0.0


def call_kwargs_for(options: GenerationOptions | None) -> dict[str, float | int]:
    """The provider kwargs for a call, with deterministic sampling unless explicitly overridden."""
    resolved = {"temperature": DETERMINISTIC}
    if options is not None:
        resolved.update(options.to_call_kwargs())
    return resolved
