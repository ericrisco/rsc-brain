// The name of the client behind a key: the web for a person's web session (never its browser's user
// agent), else the agent of a short key, the app of a connection, or the program that used a token last
// (the overview and the journal name them the same way).
export const CLIENT_SQL = `CASE WHEN c.kind = 'web' THEN 'web'
  ELSE coalesce(nullif(c.agent, ''), nullif(g.client_name, ''), nullif(c.last_client, '')) END`
