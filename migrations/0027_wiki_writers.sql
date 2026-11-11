-- Spec v0.6 «Escritura directa» (constitution P5 v2.1.0): the keys a curator of a brain let write to its wiki
-- directly. A key is what a person sees as one: a personal token or a service's main key (its credential id),
-- or a connected app (its connection id, which outlives the keys a refresh hands out); a short key writes with
-- the permission of the main key that made it. Taking the permission back is deleting the row.
CREATE TABLE wiki_writers (
  brain_id   text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  key_id     text NOT NULL CHECK (key_id ~ '^(crd|app)_[A-Za-z0-9]+$'),
  granted_by text NOT NULL REFERENCES accounts(id),
  granted_at timestamptz NOT NULL,
  PRIMARY KEY (brain_id, key_id)
);
CREATE INDEX wiki_writers_key ON wiki_writers (key_id);
