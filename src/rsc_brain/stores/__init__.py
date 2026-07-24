"""Storage interfaces: GraphStore, VectorStore, RelationalStore. Frozen in SPEC-01; implemented in SPEC-03."""

from rsc_brain.stores.graph_store import GraphEdge, GraphNode, GraphStore
from rsc_brain.stores.relational.repository import (
    DocumentRef,
    KnowledgeRepository,
    RelationalStore,
)
from rsc_brain.stores.vector_store import VectorHit, VectorRecord, VectorStore

__all__ = [
    "DocumentRef",
    "GraphEdge",
    "GraphNode",
    "GraphStore",
    "KnowledgeRepository",
    "RelationalStore",
    "VectorHit",
    "VectorRecord",
    "VectorStore",
]
