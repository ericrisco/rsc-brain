-- Spec B5 «Errores, límites y recibos» and «Flujo de eventos»: the requests per minute a key may make,
-- which the administration adjusts, and the searched text an event carries (already redacted, like
-- everything stored). Events are kept: the stream replays only the last 24 hours, and the activity of
-- a brain in the web (B6) reads further back.
ALTER TABLE installation ADD COLUMN rate_limit integer NOT NULL DEFAULT 600
  CHECK (rate_limit BETWEEN 1 AND 100000);
ALTER TABLE events ADD COLUMN query text CHECK (query IS NULL OR length(query) <= 1000);
-- What a search returned (never sent): purging an entry removes the searches that found it, with their
-- text, as it does in the trail (B1, B3).
ALTER TABLE events ADD COLUMN result_ids text[] NOT NULL DEFAULT '{}';
