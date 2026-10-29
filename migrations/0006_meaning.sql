-- Spec B3 «Búsqueda por significado»: off by default. The administration turns it on in the web, with a
-- provider and an accepted warning; a curator can exclude a brain. Vectors are plain lists of numbers
-- (no extension), normalised, so similarity is a sum of products.

CREATE TABLE meaning_settings (
  id          integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled     boolean NOT NULL DEFAULT false,
  provider    text,
  model       text,
  accepted_by text REFERENCES accounts(id),
  accepted_at timestamptz,
  changed_at  timestamptz
);
INSERT INTO meaning_settings (id) VALUES (1);

ALTER TABLE wiki_settings ADD COLUMN meaning_excluded boolean NOT NULL DEFAULT false;

CREATE TABLE meaning_vectors (
  kind       text NOT NULL CHECK (kind IN ('entry', 'page')),
  target_id  text NOT NULL,
  brain_id   text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  provider   text NOT NULL,
  model      text NOT NULL,
  text_hash  text NOT NULL,
  vec        real[] NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (kind, target_id)
);
CREATE INDEX meaning_vectors_brain ON meaning_vectors (brain_id, provider, model);
