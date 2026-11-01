-- Spec B6 «Activity», G13: each event keeps the client that did it (the web, the agent of a short key, the
-- app of a connection or the program of a token), named when it happened like the sessions and entries of
-- the journal, so the activity of a brain filters by client and the name does not change later.
ALTER TABLE events ADD COLUMN client text CHECK (client IS NULL OR length(client) <= 200);
