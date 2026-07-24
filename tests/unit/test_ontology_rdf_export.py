"""Unit tests for RDF/Turtle export (SPEC-24, FR-17.6) — must round-trip through a standard parser."""

from __future__ import annotations

from rdflib import Graph
from rdflib.namespace import OWL, RDFS

from rsc_brain.ontology.rdf_export import ExportEntity, export_turtle

ANCHORED = ExportEntity(
    id="00000000-0000-0000-0000-000000000001", name="Lease", ontology_uri="http://ex/Lease"
)
LOCAL = ExportEntity(id="00000000-0000-0000-0000-000000000002", name="Widget", ontology_uri=None)


def test_export_round_trips_through_rdflib() -> None:
    turtle = export_turtle([ANCHORED, LOCAL], uri_base="http://acme.example/kb")
    graph = Graph()
    graph.parse(data=turtle, format="turtle")  # CA#4: validates against a standard parser
    assert len(graph) >= 3


def test_anchored_entity_emits_sameas() -> None:
    turtle = export_turtle([ANCHORED], uri_base="http://acme.example/kb")
    graph = Graph()
    graph.parse(data=turtle, format="turtle")
    same_as = {str(o) for _s, _p, o in graph.triples((None, OWL.sameAs, None))}
    assert "http://ex/Lease" in same_as


def test_local_entity_has_label_no_sameas() -> None:
    turtle = export_turtle([LOCAL], uri_base="http://acme.example/kb")
    graph = Graph()
    graph.parse(data=turtle, format="turtle")
    labels = {str(o) for _s, _p, o in graph.triples((None, RDFS.label, None))}
    assert "Widget" in labels
    assert list(graph.triples((None, OWL.sameAs, None))) == []


def test_export_is_deterministic() -> None:
    a = export_turtle([ANCHORED, LOCAL], uri_base="http://acme.example/kb")
    b = export_turtle([LOCAL, ANCHORED], uri_base="http://acme.example/kb")
    assert a == b  # sorted by id ⇒ order-independent, diff-friendly


def test_export_without_uri_base_uses_default_urn() -> None:
    turtle = export_turtle([LOCAL])
    assert "urn:rsc-brain:entity:" in turtle
