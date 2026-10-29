-- The journal (spec B1): sessions, entries with their revisions, request keys (idempotency) and the
-- activity events. Every text stored here has already been through redaction.

-- unaccent() is only STABLE; the search vector needs an IMMUTABLE wrapper bound to its dictionary.
CREATE FUNCTION brain_unaccent(text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

-- What a text is searched by: its words without accents, plain and stemmed in Spanish and English.
CREATE FUNCTION brain_tsv(text) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
  AS $$ SELECT to_tsvector('simple', brain_unaccent($1))
            || to_tsvector('spanish', brain_unaccent($1))
            || to_tsvector('english', brain_unaccent($1)) $$;

-- The searchable text of an entry. array_to_string is only STABLE, hence the IMMUTABLE wrapper.
CREATE FUNCTION brain_entry_tsv(topic text, title text, content text, tags text[]) RETURNS tsvector
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$ SELECT brain_tsv(coalesce(topic, '') || ' ' || title || ' ' || content || ' ' || coalesce(array_to_string(tags, ' '), '')) $$;

CREATE TABLE sessions (
  id                  text PRIMARY KEY,
  brain_id            text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  account_id          text NOT NULL REFERENCES accounts(id),
  credential_id       text NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  bound               boolean NOT NULL DEFAULT false, -- opened by a service for one of its short keys
  purpose             text NOT NULL DEFAULT '' CHECK (length(purpose) <= 500),
  ref                 text CHECK (ref IS NULL OR length(ref) <= 200),
  day                 date, -- set for the implicit session of a key on a day
  status              text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'closed_no_summary')),
  summary_entry_id    text,
  opened_at           timestamptz NOT NULL,
  last_activity_at    timestamptz NOT NULL,
  closed_at           timestamptz
);
CREATE INDEX sessions_brain ON sessions (brain_id, opened_at DESC);
CREATE INDEX sessions_open ON sessions (credential_id, brain_id) WHERE status = 'open';
CREATE UNIQUE INDEX sessions_implicit ON sessions (credential_id, brain_id, day) WHERE day IS NOT NULL AND status = 'open';
CREATE INDEX sessions_idle ON sessions (last_activity_at) WHERE status = 'open';

CREATE TABLE entries (
  id               text PRIMARY KEY,
  brain_id         text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  session_id       text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('decision','learning','attempt','correction','preference','fact','step','summary','note')),
  topic            text CHECK (topic IS NULL OR (length(topic) <= 200 AND topic ~ '^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$')),
  title            text NOT NULL,
  content          text NOT NULL,
  applies_to       text,
  tags             text[] NOT NULL DEFAULT '{}',
  refs             text[] NOT NULL DEFAULT '{}',
  author_id        text NOT NULL REFERENCES accounts(id),
  credential_id    text REFERENCES credentials(id) ON DELETE SET NULL,
  on_behalf_id     text REFERENCES accounts(id),
  stamped_ref      text,
  revision         integer NOT NULL DEFAULT 1,
  repeat_count     integer NOT NULL DEFAULT 1,
  norm_hash        text NOT NULL,
  pinned           boolean NOT NULL DEFAULT false,
  review_after     timestamptz,
  expires_at       timestamptz,
  state            text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'forgotten', 'purged')),
  forgotten_by     text REFERENCES accounts(id),
  forgotten_reason text,
  forgotten_at     timestamptz,
  purged_by        text REFERENCES accounts(id),
  purged_reason    text,
  purged_at        timestamptz,
  superseded_by    text REFERENCES entries(id),
  compiled         boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL,
  search           tsvector GENERATED ALWAYS AS (brain_entry_tsv(topic, title, content, tags)) STORED,
  CHECK (type <> 'correction' OR topic IS NULL)
);
CREATE UNIQUE INDEX entries_topic ON entries (brain_id, topic) WHERE topic IS NOT NULL AND state = 'active';
CREATE INDEX entries_dedup ON entries (brain_id, author_id, norm_hash, created_at) WHERE topic IS NULL AND state = 'active';
CREATE INDEX entries_session ON entries (session_id, created_at);
CREATE INDEX entries_brain ON entries (brain_id, created_at DESC);
CREATE INDEX entries_ref ON entries (brain_id, stamped_ref) WHERE stamped_ref IS NOT NULL;
CREATE INDEX entries_search ON entries USING gin (search);

ALTER TABLE sessions ADD CONSTRAINT sessions_summary FOREIGN KEY (summary_entry_id) REFERENCES entries(id);

CREATE TABLE entry_revisions (
  entry_id      text NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  revision      integer NOT NULL,
  type          text NOT NULL,
  title         text NOT NULL,
  content       text NOT NULL,
  applies_to    text,
  tags          text[] NOT NULL DEFAULT '{}',
  refs          text[] NOT NULL DEFAULT '{}',
  author_id     text NOT NULL REFERENCES accounts(id),
  credential_id text REFERENCES credentials(id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (entry_id, revision)
);

CREATE TABLE request_keys (
  credential_id text NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  key           text NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  request_hash  text NOT NULL,
  receipt       jsonb NOT NULL,
  created_at    timestamptz NOT NULL,
  PRIMARY KEY (credential_id, key)
);

CREATE TABLE events (
  id            bigserial PRIMARY KEY,
  brain_id      text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  at            timestamptz NOT NULL,
  kind          text NOT NULL,
  account_id    text,
  credential_id text,
  ref           text,
  target_id     text,
  label         text
);
CREATE INDEX events_brain ON events (brain_id, id);
CREATE INDEX events_target ON events (target_id);
