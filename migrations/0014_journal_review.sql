-- Review of PR20 (spec B6 «Journal», B1).
-- A relation an agent asked about a person's correction takes effect when a person decides on it, not when
-- it was asked: that moment is kept apart from created_at (which stays when the agent asked), and a
-- contradiction is settled by a decision taken at or after it.
ALTER TABLE relations ADD COLUMN decided_at timestamptz;

-- The client that wrote a session or an entry, named when it wrote («Claude Code», «narrator», web): read
-- from the key at that moment, it no longer changes when the same key is later used by another program.
ALTER TABLE sessions ADD COLUMN client text;
ALTER TABLE entries ADD COLUMN client text;

-- What was written before this keeps the name its key gives today (the best there is).
UPDATE sessions s
   SET client = CASE WHEN c.kind = 'web' THEN 'web'
                     ELSE coalesce(nullif(c.agent, ''), nullif(g.client_name, ''), nullif(c.last_client, '')) END
  FROM credentials c LEFT JOIN oauth_grants g ON g.id = c.grant_id
 WHERE c.id = s.credential_id;
UPDATE entries e
   SET client = CASE WHEN c.kind = 'web' THEN 'web'
                     ELSE coalesce(nullif(c.agent, ''), nullif(g.client_name, ''), nullif(c.last_client, '')) END
  FROM credentials c LEFT JOIN oauth_grants g ON g.id = c.grant_id
 WHERE c.id = e.credential_id;
CREATE INDEX sessions_brain_client ON sessions (brain_id, client);
