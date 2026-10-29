-- Spec B4 «Invitar», «Roles y miembros», «Tokens personales», «Cuentas de servicio», «Avisos por email»:
-- invitations with single-use links, the outgoing mail and its log (never the content), removal of
-- people, notices in the web, and the mark that a token's expiry was already announced.

-- The account that sends mail; its password sealed with the installation secret.
ALTER TABLE installation ADD COLUMN mail jsonb;

ALTER TABLE accounts ADD COLUMN removed_at timestamptz;

-- grants: [{"brainId": "...", "role": "curator|contributor|reader"}]. Only the sha256 of the link is
-- kept. Resending makes a new link and the old one stops working.
CREATE TABLE invitations (
  id                text PRIMARY KEY,
  email             text NOT NULL CHECK (email = lower(email) AND length(email) <= 320),
  token_hash        text NOT NULL UNIQUE,
  grants            jsonb NOT NULL DEFAULT '[]',
  is_admin          boolean NOT NULL DEFAULT false,
  can_create_brains boolean NOT NULL DEFAULT false,
  invited_by        text NOT NULL REFERENCES accounts(id),
  created_at        timestamptz NOT NULL,
  expires_at        timestamptz NOT NULL,
  used_at           timestamptz,
  revoked_at        timestamptz,
  account_id        text REFERENCES accounts(id)
);
CREATE INDEX invitations_email ON invitations (email);
-- One open invitation per email at a time.
CREATE UNIQUE INDEX invitations_open ON invitations (email) WHERE used_at IS NULL AND revoked_at IS NULL;

CREATE TABLE mail_log (
  id     bigserial PRIMARY KEY,
  at     timestamptz NOT NULL,
  to_addr text NOT NULL,
  kind   text NOT NULL,
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  error  text NOT NULL DEFAULT ''
);
CREATE INDEX mail_log_at ON mail_log (at);

-- Curators who want a mail for each new proposal in this brain.
ALTER TABLE memberships ADD COLUMN notify_proposals boolean NOT NULL DEFAULT false;

-- What a person sees in the web: an administration added a service account to their brain, and so on.
CREATE TABLE notices (
  id         bigserial PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  at         timestamptz NOT NULL,
  kind       text NOT NULL,
  brain_id   text REFERENCES brains(id) ON DELETE CASCADE,
  text       text NOT NULL CHECK (length(text) <= 500),
  read_at    timestamptz
);
CREATE INDEX notices_account ON notices (account_id, at);

-- A token's expiry is announced by mail once.
ALTER TABLE credentials ADD COLUMN expiry_noticed_at timestamptz;
