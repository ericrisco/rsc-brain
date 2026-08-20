"""AUDIT-102: nothing in the product ever set a temperature.

`GenerationOptions` — "reviewed, bounded generation controls" — is threaded through both `complete`
and `complete_structured`, and **no shipped module ever constructed one**. The pipeline calls
`extractor.extract(row.text)`, the resolver calls `judge.judge(a, b)`, the retriever calls
`relevance(query, passages)`: no options, anywhere. So every call ran at the provider's default
sampling.

`gemma4:12b` declares `temperature 1`. Measured on byte-identical input, the reranker returned:

    0 scores, then 9, then 0

and at `temperature=0` it returned the same thing three times. So before this change: ingesting one
document twice could extract different claims, the contradiction judge could rule differently on the
same pair, and the abstention decision — the product's differentiating promise — was a coin flip
nobody could reproduce or debug.

**Every capability here extracts, judges or scores. None writes prose** — the retriever returns
fragments and never synthesized text, by design (FR-3.5). Sampling buys nothing and costs
reproducibility.

This is the third mechanism in three days whose tests proved it worked while nothing reached it:
`degradation_of` (AUDIT-096), the FR-9.3 model probe (AUDIT-099), and now `GenerationOptions`. The
tests below hold the property rather than the instance — that a call is deterministic by default, and
that an explicit option still wins.
"""

from __future__ import annotations

from rsc_brain.gateway.options import DETERMINISTIC, GenerationOptions, call_kwargs_for


def test_a_call_with_no_options_is_deterministic() -> None:
    """The regression. Absent options used to mean "whatever the provider felt like"."""
    kwargs = call_kwargs_for(None)
    assert kwargs.get("temperature") == DETERMINISTIC, (
        f"a call with no options sends {kwargs}; the provider's default sampling is what made the "
        "reranker return 0, then 9, then 0 scores for identical input"
    )


def test_the_default_is_actually_zero() -> None:
    """Named, so a future edit that raises it has to say so out loud."""
    assert DETERMINISTIC == 0.0


def test_an_explicit_temperature_still_wins() -> None:
    """The default must not become a ceiling. `GenerationOptions` exists to override it — that is the
    whole reason it was threaded through, and the reason it must keep working."""
    kwargs = call_kwargs_for(GenerationOptions(temperature=0.7))
    assert kwargs["temperature"] == 0.7


def test_other_controls_survive_the_merge() -> None:
    """A resolver that dropped max_tokens or top_p while fixing temperature would trade one silent
    defect for another."""
    kwargs = call_kwargs_for(GenerationOptions(max_tokens=128, top_p=0.9))
    assert kwargs["max_tokens"] == 128
    assert kwargs["top_p"] == 0.9
    assert kwargs["temperature"] == DETERMINISTIC, "unset temperature must still be pinned"


def test_the_gateway_uses_the_resolver_everywhere_it_calls_a_provider() -> None:
    """Closes the class: a third call path added later must not reintroduce the gap.

    Read from the source of the gateway module because the property is *structural* — that no
    provider call is made with raw options. There are exactly two such paths today.
    """
    import inspect

    from rsc_brain.gateway import model_gateway

    source = inspect.getsource(model_gateway)
    assert "options.to_call_kwargs() if options else" not in source, (
        "a provider call still applies options directly, so it runs at the provider's default "
        "temperature whenever the caller passes none — which every caller does"
    )
    assert source.count("call_kwargs_for(options)") >= 2, (
        "the gateway has two provider-call paths; both must resolve through the deterministic default"
    )
