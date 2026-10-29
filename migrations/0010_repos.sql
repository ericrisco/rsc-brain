-- Spec B5 «brain_resolve»: curators link the repositories a brain is about, so an agent working in
-- one finds its brain. A repository may be linked to several brains (each team links its own); an
-- agent is answered with the ones its key can see. The address is kept normalised (host, port and
-- path, lowercase, no protocol, user or ".git").
CREATE TABLE repo_links (
  url_key    text NOT NULL CHECK (length(url_key) BETWEEN 3 AND 300),
  brain_id   text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  added_by   text NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (url_key, brain_id)
);
CREATE INDEX repo_links_brain ON repo_links (brain_id);
