-- Spec B4 «Asistente de primera vez» and «Entrar»: the installation itself (its name, public address,
-- whether the first-time setup is done, the epoch every key belongs to), passwords and the second
-- factor of people, the brake on failed sign-ins, and single-use password reset links.

CREATE TABLE installation (
  id              integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name            text NOT NULL DEFAULT '' CHECK (length(name) <= 80),
  public_url      text CHECK (public_url IS NULL OR length(public_url) <= 300),
  setup_done_at   timestamptz,
  -- Restoring a copy moves the epoch (spec B4 CA33, B7): every key of an earlier epoch stops working.
  key_epoch       integer NOT NULL DEFAULT 1,
  curators_invite boolean NOT NULL DEFAULT false
);
INSERT INTO installation (id) VALUES (1);
-- An installation bootstrapped from the command line before B4 is already set up.
UPDATE installation SET setup_done_at = now() WHERE EXISTS (SELECT 1 FROM accounts WHERE is_admin);

ALTER TABLE accounts ADD COLUMN password_hash text;
ALTER TABLE accounts ADD COLUMN totp_secret text;          -- sealed with the installation secret
ALTER TABLE accounts ADD COLUMN totp_pending text;         -- sealed; until the first code confirms it
ALTER TABLE accounts ADD COLUMN totp_last_step bigint;     -- a code works once

ALTER TABLE credentials ADD COLUMN epoch integer NOT NULL DEFAULT 1;
ALTER TABLE credentials ADD COLUMN last_client text CHECK (last_client IS NULL OR length(last_client) <= 200);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by text REFERENCES accounts(id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);
CREATE INDEX password_resets_account ON password_resets (account_id);

-- The brake on sign-ins, by email: every attempt is counted before the password is checked, in one
-- statement, so attempts sent at once cannot slip past it; unknown emails are braked the same way, so
-- the brake does not tell which emails have an account.
CREATE TABLE login_brakes (
  email        text PRIMARY KEY CHECK (length(email) <= 320),
  failures     integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);
