-- Spec B5 «Flujo de eventos»: the order in which events are delivered. An id is given when a row is
-- written, but the row becomes visible when its transaction commits, so a long write can show up after
-- later ids were already handed out. The live feed therefore numbers events itself, in the order it
-- sees them: `seq` stays empty until then, and streams, resuming (Last-Event-ID) and gaps go by `seq`.
-- A write that commits late simply gets a later number; none is skipped.
ALTER TABLE events ADD COLUMN seq bigint;
CREATE SEQUENCE events_seq AS bigint;

-- The events already there, numbered in id order.
UPDATE events e SET seq = n.seq
  FROM (SELECT id, row_number() OVER (ORDER BY id) AS seq FROM events) n
 WHERE e.id = n.id;
SELECT setval('events_seq', coalesce(max(seq), 0) + 1, false) FROM events;

CREATE UNIQUE INDEX events_seq_key ON events (seq);
-- What the feed has still to number.
CREATE INDEX events_unsequenced ON events (id) WHERE seq IS NULL;
-- Resuming a brain reads its events by number.
DROP INDEX events_brain;
CREATE INDEX events_brain ON events (brain_id, seq);
