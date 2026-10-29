-- Spec B3 «Contexto de arranque» and «Rastro de lo consultado»: the curators' usage note that opens the
-- context, the session of each trail line, and the per-target counters the trail is folded into after
-- 90 days.

ALTER TABLE wiki_settings ADD COLUMN usage_note text NOT NULL DEFAULT '' CHECK (length(usage_note) <= 2000);

ALTER TABLE trail ADD COLUMN session_id text;
CREATE INDEX trail_session ON trail (brain_id, session_id) WHERE session_id IS NOT NULL;

-- What a trail older than 90 days leaves behind: how many times each entry or page came back.
CREATE TABLE trail_counts (
  brain_id   text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  target_id  text NOT NULL,
  reads      bigint NOT NULL DEFAULT 0,
  searches   bigint NOT NULL DEFAULT 0,
  contexts   bigint NOT NULL DEFAULT 0,
  until      timestamptz NOT NULL,
  PRIMARY KEY (brain_id, target_id)
);
