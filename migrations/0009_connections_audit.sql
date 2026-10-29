-- Spec B4 «Conexiones con el inicio de sesión estándar de MCP» and «Auditoría»: clients that sign in
-- with the standard flow, single-use authorization codes, the connections people consent to (each with
-- a refresh token that rotates), the short-lived access keys of a connection, and an audit trail that
-- the database itself refuses to change.

-- A client: its id is the address of its metadata document (fetched, kind 'cimd'), or one Brain gave
-- it when it registered itself (kind 'dcr').
CREATE TABLE oauth_clients (
  client_id     text PRIMARY KEY CHECK (length(client_id) <= 500),
  kind          text NOT NULL CHECK (kind IN ('cimd', 'dcr')),
  name          text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  redirect_uris text[] NOT NULL,
  fetched_at    timestamptz,
  created_at    timestamptz NOT NULL
);

-- What a person consented to: these brains, read or read + write, for this client. Only the hash of
-- the current refresh token (and of the previous one, to detect a replay) is kept.
CREATE TABLE oauth_grants (
  id            text PRIMARY KEY,
  client_id     text NOT NULL REFERENCES oauth_clients(client_id),
  client_name   text NOT NULL,
  redirect_host text NOT NULL,
  account_id    text NOT NULL REFERENCES accounts(id),
  brain_ids     text[] NOT NULL,
  perm          text NOT NULL CHECK (perm IN ('read', 'write')),
  refresh_hash  text NOT NULL UNIQUE,
  previous_hash text,
  epoch         integer NOT NULL,
  created_at    timestamptz NOT NULL,
  last_used_at  timestamptz NOT NULL,
  expires_max   timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX oauth_grants_account ON oauth_grants (account_id);
CREATE INDEX oauth_grants_previous ON oauth_grants (previous_hash);

CREATE TABLE oauth_codes (
  code_hash      text PRIMARY KEY,
  client_id      text NOT NULL REFERENCES oauth_clients(client_id),
  account_id     text NOT NULL REFERENCES accounts(id),
  brain_ids      text[] NOT NULL,
  perm           text NOT NULL CHECK (perm IN ('read', 'write')),
  challenge      text NOT NULL,
  redirect_uri   text NOT NULL,
  resource       text NOT NULL,
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz
);

-- The access key of a connection is a credential of kind 'app': an hour long, tied to its grant.
ALTER TABLE credentials DROP CONSTRAINT credentials_kind_check;
ALTER TABLE credentials ADD CONSTRAINT credentials_kind_check
  CHECK (kind IN ('token', 'main', 'short', 'web', 'app'));
ALTER TABLE credentials ADD COLUMN grant_id text REFERENCES oauth_grants(id);
ALTER TABLE credentials ADD CONSTRAINT credentials_app_grant CHECK (kind <> 'app' OR (grant_id IS NOT NULL AND expires_at IS NOT NULL));
CREATE INDEX credentials_grant ON credentials (grant_id);

-- Nobody edits the audit: not the web, not a bug.
CREATE FUNCTION audit_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the audit trail is append-only';
END $$;
CREATE TRIGGER audit_append_only BEFORE UPDATE OR DELETE ON audit
  FOR EACH ROW EXECUTE FUNCTION audit_is_append_only();
CREATE INDEX audit_at ON audit (at, id);
CREATE INDEX audit_actor ON audit (actor_id, at);
