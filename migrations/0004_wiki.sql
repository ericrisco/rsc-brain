-- Spec B2, the compiled wiki: pages with a type and an address, typed links, sources, proposals that a
-- person approves in the web, the log, and the per-brain settings (compile guide, map intro, health).

-- A person in the web holds a "web" credential (a session). It is presented as a cookie, never as a
-- bearer key, and it is the only credential that approves, edits pages by hand or purges (spec B2).
ALTER TABLE credentials DROP CONSTRAINT credentials_kind_check;
ALTER TABLE credentials ADD CONSTRAINT credentials_kind_check CHECK (kind IN ('token', 'main', 'short', 'web'));
ALTER TABLE credentials ADD CONSTRAINT credentials_web_expires CHECK (kind <> 'web' OR expires_at IS NOT NULL);

CREATE FUNCTION brain_page_tsv(address text, title text, summary text, body text, tags text[]) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT brain_tsv(replace(address, '/', ' ') || ' ' || title || ' ' || summary || ' ' || body || ' ' || coalesce(array_to_string(tags, ' '), '')) $$;

CREATE TABLE pages (
  id            text PRIMARY KEY,
  brain_id      text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  address       text NOT NULL CHECK (length(address) BETWEEN 1 AND 200),
  type          text NOT NULL CHECK (type IN ('topic', 'entity', 'decision', 'guide', 'agent', 'source', 'overview')),
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 260),
  summary       text NOT NULL DEFAULT '' CHECK (length(summary) <= 400),
  body          text NOT NULL DEFAULT '' CHECK (length(body) <= 120000),
  tags          text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'stale', 'superseded', 'retired')),
  superseded_by text REFERENCES pages(id) ON DELETE SET NULL,
  revision      integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at    timestamptz NOT NULL,
  updated_at    timestamptz NOT NULL,
  search        tsvector GENERATED ALWAYS AS (brain_page_tsv(address, title, summary, body, tags)) STORED
);
-- Not unique here: which page an address leads to is page_addresses' job (a merged page keeps its last
-- address as text while that address now leads to the page it was merged into).
CREATE INDEX pages_address ON pages (brain_id, address);
CREATE INDEX pages_search ON pages USING gin (search);

-- Every address a page has had. The key makes an old address reserved for that page forever: it
-- redirects to it and cannot be given to another page; it can be given back to the same one.
CREATE TABLE page_addresses (
  brain_id   text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  address    text NOT NULL,
  page_id    text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (brain_id, address)
);
CREATE INDEX page_addresses_page ON page_addresses (page_id);

CREATE TABLE proposals (
  id             text PRIMARY KEY,
  brain_id       text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 260),
  reason         text NOT NULL DEFAULT '' CHECK (length(reason) <= 2600),
  author_id      text NOT NULL REFERENCES accounts(id),
  credential_id  text NOT NULL,
  agent          text,
  status         text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'partially_approved', 'returned', 'withdrawn', 'superseded')),
  supersedes_id  text REFERENCES proposals(id) ON DELETE SET NULL,
  superseded_by  text REFERENCES proposals(id) ON DELETE SET NULL,
  collected      text[] NOT NULL DEFAULT '{}',   -- entries read and found to add nothing new
  comment        text,
  decided_by     text REFERENCES accounts(id),
  decided_at     timestamptz,
  last_error     text,
  created_at     timestamptz NOT NULL,
  purged_by      text REFERENCES accounts(id),
  purged_at      timestamptz,
  purged_reason  text
);
CREATE INDEX proposals_inbox ON proposals (brain_id, status, created_at);

CREATE TABLE proposal_ops (
  proposal_id      text NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  idx              integer NOT NULL CHECK (idx >= 0),
  op               jsonb NOT NULL,
  status           text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'returned')),
  corrected_by     text REFERENCES accounts(id),
  base_reviewed_by text REFERENCES accounts(id),
  applied_page     text,
  applied_revision integer,
  PRIMARY KEY (proposal_id, idx)
);
CREATE INDEX proposal_ops_sources ON proposal_ops USING gin ((op -> 'sources'));

CREATE TABLE page_revisions (
  page_id        text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  revision       integer NOT NULL,
  address        text NOT NULL,
  type           text NOT NULL,
  title          text NOT NULL,
  summary        text NOT NULL,
  body           text NOT NULL,
  tags           text[] NOT NULL,
  status         text NOT NULL,
  sources        jsonb NOT NULL DEFAULT '[]',
  links          jsonb NOT NULL DEFAULT '[]',
  kind           text NOT NULL CHECK (kind IN ('proposal', 'direct', 'revert', 'purge')),
  author_id      text NOT NULL REFERENCES accounts(id),
  credential_id  text NOT NULL,
  proposal_id    text REFERENCES proposals(id) ON DELETE SET NULL,
  op_index       integer,
  corrected      boolean NOT NULL DEFAULT false,
  base_reviewed  boolean NOT NULL DEFAULT false,
  note           text,
  created_at     timestamptz NOT NULL,
  purged_by      text REFERENCES accounts(id),
  purged_at      timestamptz,
  purged_reason  text,
  PRIMARY KEY (page_id, revision)
);

-- The current sources of a page: journal entries of the brain, or external addresses.
CREATE TABLE page_sources (
  page_id  text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  entry_id text REFERENCES entries(id) ON DELETE CASCADE,
  url      text CHECK (url IS NULL OR length(url) <= 2000),
  title    text CHECK (title IS NULL OR length(title) <= 300),
  CHECK ((entry_id IS NULL) <> (url IS NULL))
);
CREATE UNIQUE INDEX page_sources_entry ON page_sources (page_id, entry_id) WHERE entry_id IS NOT NULL;
CREATE UNIQUE INDEX page_sources_url ON page_sources (page_id, url) WHERE url IS NOT NULL;
CREATE INDEX page_sources_by_entry ON page_sources (entry_id) WHERE entry_id IS NOT NULL;

-- Links from a page. Typed links point at a page; "mentions" come from [[address]] in the body and
-- point at an address, resolved when read (through page_addresses), so a move never rewrites bodies.
CREATE TABLE page_links (
  brain_id   text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  from_page  text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  kind       text NOT NULL CHECK (kind IN ('mentions', 'related', 'depends-on', 'contradicts', 'supersedes', 'part-of', 'example-of')),
  to_page    text REFERENCES pages(id) ON DELETE CASCADE,
  to_address text,
  CHECK ((kind = 'mentions') = (to_address IS NOT NULL AND to_page IS NULL)),
  CHECK (to_page IS NULL OR to_page <> from_page)
);
CREATE UNIQUE INDEX page_links_typed ON page_links (from_page, kind, to_page) WHERE to_page IS NOT NULL;
CREATE UNIQUE INDEX page_links_mentions ON page_links (from_page, to_address) WHERE to_address IS NOT NULL;
CREATE INDEX page_links_to ON page_links (to_page) WHERE to_page IS NOT NULL;
CREATE INDEX page_links_to_address ON page_links (brain_id, to_address) WHERE to_address IS NOT NULL;

CREATE TABLE wiki_settings (
  brain_id          text PRIMARY KEY REFERENCES brains(id) ON DELETE CASCADE,
  guide             text CHECK (guide IS NULL OR length(guide) <= 20000),
  map_intro         text NOT NULL DEFAULT '' CHECK (length(map_intro) <= 4000),
  stale_days        integer NOT NULL DEFAULT 90 CHECK (stale_days BETWEEN 1 AND 3650),
  long_chars        integer NOT NULL DEFAULT 20000 CHECK (long_chars BETWEEN 1000 AND 100000),
  maintenance_every integer NOT NULL DEFAULT 20 CHECK (maintenance_every BETWEEN 1 AND 1000),
  approvals_since   integer NOT NULL DEFAULT 0
);

CREATE TABLE wiki_log (
  id          text PRIMARY KEY,
  brain_id    text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  at          timestamptz NOT NULL,
  actor_id    text NOT NULL REFERENCES accounts(id),
  kind        text NOT NULL CHECK (kind IN ('proposal', 'direct', 'revert', 'purge')),
  proposal_id text REFERENCES proposals(id) ON DELETE SET NULL,
  summary     text NOT NULL CHECK (length(summary) <= 500),
  pages       text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX wiki_log_brain ON wiki_log (brain_id, at DESC, id DESC);
