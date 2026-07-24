"""Export anchored entities as RDF/Turtle (SPEC-24, FR-17.6). Round-trips through rdflib.

Each entity with a valid anchor emits ``<entity_iri> owl:sameAs <ontology_uri>`` plus an
``rdfs:label``; unanchored entities are minted under the project ``uri_base`` (open-world — they are
still exported, just not aligned). The graph is deterministic (sorted) so exports diff cleanly.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass

from rdflib import Graph, Literal, URIRef
from rdflib.namespace import OWL, RDFS

_DEFAULT_BASE = "urn:rsc-brain:entity:"


@dataclass(frozen=True, slots=True)
class ExportEntity:
    id: str
    name: str
    ontology_uri: str | None


def export_turtle(entities: Iterable[ExportEntity], *, uri_base: str | None = None) -> str:
    base = uri_base.rstrip("#/") + "/" if uri_base else _DEFAULT_BASE
    graph = Graph()
    graph.bind("owl", OWL)
    graph.bind("rdfs", RDFS)
    for entity in sorted(entities, key=lambda e: e.id):
        subject = URIRef(f"{base}{entity.id}")
        graph.add((subject, RDFS.label, Literal(entity.name)))
        if entity.ontology_uri:
            graph.add((subject, OWL.sameAs, URIRef(entity.ontology_uri)))
    return graph.serialize(format="turtle")
