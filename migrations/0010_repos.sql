-- Spec B5 «brain_resolve»: a curator links the repositories a brain is about, so an agent working in
-- one finds its brain. A repository points to one brain; its address is kept normalised (host and
-- path, lowercase, no protocol, user or ".git").
CREATE TABLE repo_links (
  url_key    text PRIMARY KEY CHECK (length(url_key) BETWEEN 3 AND 300),
  brain_id   text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  added_by   text NOT NULL REFERENCES accounts(id),
  created_at timestamptz NOT NULL
);
CREATE INDEX repo_links_brain ON repo_links (brain_id);
