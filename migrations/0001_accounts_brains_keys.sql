-- Who can act (accounts), where (brains, memberships) and with which key (credentials).
-- The minimum of spec B4 that the journal (B1) needs; B4 extends these tables.

CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE TABLE accounts (
  id                text PRIMARY KEY,
  kind              text NOT NULL CHECK (kind IN ('person', 'service')),
  email             text UNIQUE CHECK (email IS NULL OR email = lower(email)),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  is_admin          boolean NOT NULL DEFAULT false,
  can_create_brains boolean NOT NULL DEFAULT false,
  can_invite        boolean NOT NULL DEFAULT false,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_at        timestamptz NOT NULL,
  CHECK ((kind = 'person') = (email IS NOT NULL)),
  CHECK (kind = 'person' OR NOT is_admin)
);

CREATE TABLE brains (
  id                    text PRIMARY KEY,
  slug                  text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) BETWEEN 2 AND 64),
  name                  text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  description           text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  purpose               text NOT NULL DEFAULT '' CHECK (length(purpose) <= 1000),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  pending_curator_email text,
  created_by            text NOT NULL REFERENCES accounts(id),
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL
);

CREATE TABLE memberships (
  brain_id   text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id),
  role       text NOT NULL CHECK (role IN ('curator', 'contributor', 'reader')),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (brain_id, account_id)
);
CREATE INDEX memberships_account ON memberships (account_id);

-- token: a person's key (scope: all their brains, or a list) · main: a service account's key ·
-- short: a key a service account mints for one job (one brain to write, some to read).
CREATE TABLE credentials (
  id             text PRIMARY KEY,
  account_id     text NOT NULL REFERENCES accounts(id),
  kind           text NOT NULL CHECK (kind IN ('token', 'main', 'short')),
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  secret_hash    text NOT NULL UNIQUE,
  last4          text NOT NULL,
  perm           text NOT NULL CHECK (perm IN ('read', 'write')),
  all_brains     boolean NOT NULL DEFAULT false,
  brain_ids      text[] NOT NULL DEFAULT '{}',
  write_brain_id text REFERENCES brains(id) ON DELETE SET NULL,
  read_brain_ids text[] NOT NULL DEFAULT '{}',
  ref            text CHECK (ref IS NULL OR length(ref) <= 200),
  agent          text CHECK (agent IS NULL OR length(agent) <= 80),
  on_behalf_id   text REFERENCES accounts(id),
  parent_id      text REFERENCES credentials(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL,
  expires_at     timestamptz,
  revoked_at     timestamptz,
  last_used_at   timestamptz,
  CHECK (kind <> 'short' OR (parent_id IS NOT NULL AND expires_at IS NOT NULL AND (write_brain_id IS NOT NULL OR revoked_at IS NOT NULL))),
  CHECK (kind <> 'token' OR expires_at IS NOT NULL),
  CHECK (cardinality(read_brain_ids) = 0 OR on_behalf_id IS NOT NULL)
);
CREATE INDEX credentials_account ON credentials (account_id);
CREATE INDEX credentials_parent ON credentials (parent_id);

CREATE TABLE audit (
  id            bigserial PRIMARY KEY,
  at            timestamptz NOT NULL,
  actor_id      text,
  credential_id text,
  action        text NOT NULL,
  brain_id      text,
  target        text,
  outcome       text NOT NULL CHECK (outcome IN ('ok', 'denied')),
  detail        text NOT NULL DEFAULT ''
);
CREATE INDEX audit_brain ON audit (brain_id, at);
