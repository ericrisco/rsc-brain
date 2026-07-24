"""Unit tests for the in-memory ontology index (SPEC-24, §4.2 / FR-17.2/17.4/17.5)."""

from __future__ import annotations

import pytest

from rsc_brain.ontology.index import OntologyIndex, OntologyParseError

# A minimal SKOS+OWL fixture spanning both verticals in the spec: legal (subClassOf hierarchy) and
# medical (SKOS synonyms + broader/narrower + owl:sameAs), plus one property with domain/range.
FIXTURE = """
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ex: <http://example.org/legal#> .

ex:Contract a owl:Class ; rdfs:label "contract" .
ex:Lease a owl:Class ; rdfs:label "lease" ; rdfs:subClassOf ex:Contract .
ex:Sale a owl:Class ; rdfs:label "sale" ; rdfs:subClassOf ex:Contract .
ex:Sublease a owl:Class ; rdfs:label "sublease" ; rdfs:subClassOf ex:Lease .

ex:Person a owl:Class ; rdfs:label "person" .
ex:Company a owl:Class ; rdfs:label "company" .
ex:signs a owl:ObjectProperty ; rdfs:label "signs" ; rdfs:domain ex:Person ; rdfs:range ex:Contract .

ex:MI a skos:Concept ; skos:prefLabel "myocardial infarction" ; skos:altLabel "heart attack" .
ex:AMI a skos:Concept ; skos:prefLabel "acute myocardial infarction" ; owl:sameAs ex:MI .
ex:CardiacEvent a skos:Concept ; skos:prefLabel "cardiac event" ; skos:narrower ex:MI .
"""

CONTRACT = "http://example.org/legal#Contract"
LEASE = "http://example.org/legal#Lease"
SALE = "http://example.org/legal#Sale"
SUBLEASE = "http://example.org/legal#Sublease"
PERSON = "http://example.org/legal#Person"
COMPANY = "http://example.org/legal#Company"
MI = "http://example.org/legal#MI"
AMI = "http://example.org/legal#AMI"
CARDIAC = "http://example.org/legal#CardiacEvent"


@pytest.fixture
def index() -> OntologyIndex:
    return OntologyIndex.parse(FIXTURE, "turtle")


def test_parse_reports_triple_count(index: OntologyIndex) -> None:
    assert index.triples > 0


def test_exact_anchor_by_label(index: OntologyIndex) -> None:
    assert index.anchor("contract") == CONTRACT
    assert index.anchor("Contract") == CONTRACT  # case-insensitive


def test_anchor_by_skos_alt_and_pref_label(index: OntologyIndex) -> None:
    assert index.anchor("heart attack") == MI
    assert index.anchor("myocardial infarction") == MI


def test_unanchored_returns_none(index: OntologyIndex) -> None:
    assert index.anchor("nonexistent concept") is None


def test_fuzzy_anchor_within_threshold(index: OntologyIndex) -> None:
    assert index.anchor("contarct", strategy="fuzzy", threshold=0.8) == CONTRACT
    # exact strategy never fuzzy-matches a typo
    assert index.anchor("contarct", strategy="exact") is None


def test_fuzzy_below_threshold_is_none(index: OntologyIndex) -> None:
    assert index.anchor("banana", strategy="fuzzy", threshold=0.9) is None


def test_same_as_is_symmetric(index: OntologyIndex) -> None:
    assert MI in index.same_as(AMI)
    assert AMI in index.same_as(MI)


def test_descendants_subclass_depth_1(index: OntologyIndex) -> None:
    assert index.descendants(CONTRACT, depth=1) == {LEASE, SALE}


def test_descendants_depth_2_reaches_grandchild(index: OntologyIndex) -> None:
    assert SUBLEASE in index.descendants(CONTRACT, depth=2)
    assert SUBLEASE not in index.descendants(CONTRACT, depth=1)


def test_descendants_skos_narrower(index: OntologyIndex) -> None:
    assert MI in index.descendants(CARDIAC, depth=1)


def test_expand_query_labels_reaches_subclasses(index: OntologyIndex) -> None:
    # U25: a query for the superclass expands to its subclasses' labels.
    assert index.expand_query_labels("all our contracts", depth=1) == {"lease", "sale"}


def test_expand_query_labels_empty_when_no_hit(index: OntologyIndex) -> None:
    assert index.expand_query_labels("quarterly revenue report", depth=1) == set()


def test_property_iri(index: OntologyIndex) -> None:
    assert index.property_iri("signs") == "http://example.org/legal#signs"
    assert index.property_iri("owns") is None


def test_check_relation_valid_uses_subclass(index: OntologyIndex) -> None:
    # Person signs Lease: Lease is-a Contract (the property's range) ⇒ valid.
    assert index.check_relation("signs", PERSON, LEASE) is True


def test_check_relation_range_violation(index: OntologyIndex) -> None:
    # Person signs Company: Company is not a Contract ⇒ range violation.
    assert index.check_relation("signs", PERSON, COMPANY) is False


def test_check_relation_domain_violation(index: OntologyIndex) -> None:
    # Company signs Contract: domain is Person ⇒ domain violation.
    assert index.check_relation("signs", COMPANY, CONTRACT) is False


def test_check_relation_open_world_passes_unknowns(index: OntologyIndex) -> None:
    assert index.check_relation("unknownpredicate", PERSON, COMPANY) is True  # unmatched property
    assert index.check_relation("signs", None, None) is True  # unanchored endpoints


def test_parse_invalid_raises() -> None:
    with pytest.raises(OntologyParseError):
        OntologyIndex.parse("this is not valid turtle @@@ <<< ;", "turtle")
