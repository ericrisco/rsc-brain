-- Enable the AGE (graph) and pgvector (vector) extensions in the application database on
-- first initialization. SPEC-03 creates the per-project graphs and the vector columns; this
-- only makes the extensions available. Idempotent so re-runs are safe.
CREATE EXTENSION IF NOT EXISTS age;
CREATE EXTENSION IF NOT EXISTS vector;
