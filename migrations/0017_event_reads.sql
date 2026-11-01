-- Review of PR23 (spec B6 «Activity»). Activity opens the live feed from the start of the last 24 hours, and
-- the gap check looks for older events of one brain: both read events by brain and time, so they get an
-- index on (brain_id, at) instead of scanning the whole table.
CREATE INDEX events_brain_at ON events (brain_id, at);

-- Events written before 0016 have no client: they take the one their key gives today (as sessions and entries
-- did in 0014). Only a web session is "web"; a key whose agent or program says "web" is named by the key.
UPDATE events e
   SET client = left(CASE WHEN c.kind = 'web' THEN 'web'
     ELSE coalesce(CASE WHEN lower(btrim(c.agent)) IN ('', 'web') THEN NULL ELSE c.agent END,
                   CASE WHEN lower(btrim(g.client_name)) IN ('', 'web') THEN NULL ELSE g.client_name END,
                   CASE WHEN lower(btrim(c.last_client)) IN ('', 'web') THEN NULL ELSE c.last_client END,
                   CASE WHEN lower(btrim(c.name)) IN ('', 'web') THEN NULL ELSE c.name END) END, 200)
  FROM credentials c LEFT JOIN oauth_grants g ON g.id = c.grant_id
 WHERE c.id = e.credential_id AND e.client IS NULL;
