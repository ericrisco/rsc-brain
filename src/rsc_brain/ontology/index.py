"""In-memory ontology index over rdflib (SPEC-24, §B.5) — no dedicated triple-store in v1.

Parses an OWL/RDF/SKOS document and derives the structures anchoring + bounded inference need:
normalized labels → IRI (``rdfs:label`` / ``skos:prefLabel`` / ``skos:altLabel``), ``owl:sameAs``,
and the ``rdfs:subClassOf`` + ``skos:broader/narrower`` hierarchy. Anchoring is ``exact`` (label) or
``fuzzy`` (ratio ≥ threshold); ``embedding`` is a gateway-backed seam done in ingest, not here.
Inference is strictly those two predicates, depth-bounded — never a full OWL reasoner (FR-17.5).
"""

from __future__ import annotations

import difflib
from collections import deque
from dataclasses import dataclass, field

from rdflib import RDFS, Graph, URIRef
from rdflib.namespace import OWL, SKOS


class OntologyParseError(ValueError):
    """The ontology document could not be parsed as OWL/RDF/SKOS."""


def _norm(text: str) -> str:
    return " ".join(text.strip().casefold().split())


def _token_matches(token: str, label: str) -> bool:
    """A query token matches a single-word label exactly, or as a plural/stem variant (either is a
    prefix of the other, for labels long enough that a prefix is unambiguous)."""
    if token == label:
        return True
    return len(label) >= 4 and (token.startswith(label) or label.startswith(token))


@dataclass(slots=True)
class OntologyIndex:
    triples: int
    _labels: dict[str, str] = field(default_factory=dict)  # normalized label → IRI
    _subclasses: dict[str, set[str]] = field(default_factory=dict)  # parent IRI → child IRIs
    _superclasses: dict[str, set[str]] = field(default_factory=dict)  # child IRI → parent IRIs
    _narrower: dict[str, set[str]] = field(default_factory=dict)  # broad IRI → narrower IRIs
    _same_as: dict[str, set[str]] = field(default_factory=dict)
    _domain: dict[str, str] = field(default_factory=dict)  # property IRI → domain class IRI
    _range: dict[str, str] = field(default_factory=dict)  # property IRI → range class IRI

    @classmethod
    def parse(cls, content: str, fmt: str = "turtle") -> OntologyIndex:
        return cls.parse_many([(content, fmt)])

    @classmethod
    def parse_many(cls, documents: list[tuple[str, str]]) -> OntologyIndex:
        """Parse one or more (content, format) ontology documents into a single merged index."""
        graph = Graph()
        for content, fmt in documents:
            try:
                graph.parse(data=content, format=_rdflib_format(fmt))
            except Exception as exc:  # rdflib raises a variety of parse exceptions
                raise OntologyParseError(str(exc)) from exc
        index = cls(triples=len(graph))
        for predicate in (RDFS.label, SKOS.prefLabel, SKOS.altLabel):
            for subject, _p, label in graph.triples((None, predicate, None)):
                if isinstance(subject, URIRef):
                    index._labels.setdefault(_norm(str(label)), str(subject))
        for child, _p, parent in graph.triples((None, RDFS.subClassOf, None)):
            if isinstance(child, URIRef) and isinstance(parent, URIRef):
                index._subclasses.setdefault(str(parent), set()).add(str(child))
                index._superclasses.setdefault(str(child), set()).add(str(parent))
        for prop, _p, domain in graph.triples((None, RDFS.domain, None)):
            if isinstance(prop, URIRef) and isinstance(domain, URIRef):
                index._domain[str(prop)] = str(domain)
        for prop, _p, rng in graph.triples((None, RDFS.range, None)):
            if isinstance(prop, URIRef) and isinstance(rng, URIRef):
                index._range[str(prop)] = str(rng)
        for narrow, _p, broad in graph.triples((None, SKOS.broader, None)):
            if isinstance(narrow, URIRef) and isinstance(broad, URIRef):
                index._narrower.setdefault(str(broad), set()).add(str(narrow))
        for broad, _p, narrow in graph.triples((None, SKOS.narrower, None)):
            if isinstance(broad, URIRef) and isinstance(narrow, URIRef):
                index._narrower.setdefault(str(broad), set()).add(str(narrow))
        for a, _p, b in graph.triples((None, OWL.sameAs, None)):
            if isinstance(a, URIRef) and isinstance(b, URIRef):
                index._same_as.setdefault(str(a), set()).add(str(b))
                index._same_as.setdefault(str(b), set()).add(str(a))
        return index

    def anchor(self, name: str, *, strategy: str = "exact", threshold: float = 0.85) -> str | None:
        """The IRI ``name`` anchors to, or None (unanchored ⇒ kept local, open-world)."""
        normalized = _norm(name)
        if normalized in self._labels:
            return self._labels[normalized]
        if strategy == "fuzzy" and self._labels:
            best = max(
                self._labels,
                key=lambda label: difflib.SequenceMatcher(None, normalized, label).ratio(),
            )
            if difflib.SequenceMatcher(None, normalized, best).ratio() >= threshold:
                return self._labels[best]
        return None

    def same_as(self, iri: str) -> set[str]:
        return set(self._same_as.get(iri, set()))

    def property_iri(self, predicate: str) -> str | None:
        """The IRI a relation predicate label anchors to, if the ontology defines the property."""
        return self._labels.get(_norm(predicate))

    def is_a(self, iri: str, expected: str, *, depth: int = 5) -> bool:
        """True iff ``iri`` is ``expected`` or a bounded ``rdfs:subClassOf`` descendant of it."""
        if iri == expected:
            return True
        frontier: deque[tuple[str, int]] = deque([(iri, 0)])
        seen = {iri}
        while frontier:
            current, level = frontier.popleft()
            if level >= depth:
                continue
            for parent in self._superclasses.get(current, set()):
                if parent == expected:
                    return True
                if parent not in seen:
                    seen.add(parent)
                    frontier.append((parent, level + 1))
        return False

    def check_relation(
        self, predicate: str, subject_iri: str | None, object_iri: str | None
    ) -> bool:
        """FR-17.4 domain/range check. Open-world: a relation is a violation ONLY when the property
        AND the relevant endpoint are both anchored and the endpoint fails domain/range; anything
        unknown (unmatched property, unanchored endpoint, no declared domain/range) passes."""
        prop = self.property_iri(predicate)
        if prop is None:
            return True
        domain = self._domain.get(prop)
        if domain is not None and subject_iri is not None and not self.is_a(subject_iri, domain):
            return False
        rng = self._range.get(prop)
        return not (rng is not None and object_iri is not None and not self.is_a(object_iri, rng))

    def labels_of(self, iri: str) -> set[str]:
        return {label for label, target in self._labels.items() if target == iri}

    def labels_in_text(self, text: str) -> set[str]:
        """IRIs whose label the text mentions. Multi-word labels match as a phrase; single-word
        labels tolerate simple plural/stem variants (so "contracts" hits the label "contract")."""
        normalized = _norm(text)
        padded = f" {normalized} "
        tokens = normalized.split()
        hits: set[str] = set()
        for label, iri in self._labels.items():
            if " " in label:
                if f" {label} " in padded:
                    hits.add(iri)
            elif any(_token_matches(token, label) for token in tokens):
                hits.add(iri)
        return hits

    def expand_query_labels(self, text: str, *, depth: int = 1) -> set[str]:
        """FR-17.5: the extra labels a query should also match. Any ontology label mentioned in
        ``text`` contributes the labels of its bounded ``subClassOf``/``narrower`` descendants (so
        "contracts" reaches "leases"/"sales"), minus labels the query already mentions."""
        present = self.labels_in_text(text)
        extra: set[str] = set()
        for iri in present:
            for descendant in self.descendants(iri, depth=depth):
                if descendant not in present:
                    extra |= self.labels_of(descendant)
        return extra

    def descendants(self, iri: str, *, depth: int = 1) -> set[str]:
        """IRIs reachable from ``iri`` via subclasses + ``skos:narrower``, up to ``depth`` (the
        bounded FR-17.5 expansion — a query for a superclass reaches its subclasses)."""
        found: set[str] = set()
        frontier: deque[tuple[str, int]] = deque([(iri, 0)])
        while frontier:
            current, level = frontier.popleft()
            if level >= depth:
                continue
            for child in self._subclasses.get(current, set()) | self._narrower.get(current, set()):
                if child not in found:
                    found.add(child)
                    frontier.append((child, level + 1))
        return found


def _rdflib_format(fmt: str) -> str:
    return {"owl": "xml", "rdf": "xml", "skos": "xml", "turtle": "turtle", "ttl": "turtle"}.get(
        fmt.lower(), fmt.lower()
    )
