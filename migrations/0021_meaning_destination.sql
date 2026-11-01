-- Second review of B6 PR25b. Meaning search remembers where it agreed to send text: a fingerprint of the
-- destination taken when the warning is accepted (the provider, and a keyed hash of its key or the origin of
-- its address), and why it was turned off when the live destination stopped matching. The mail password
-- version moves to its own column, so removing the mail settings never takes it back.
ALTER TABLE meaning_settings
  ADD COLUMN destination text,
  ADD COLUMN off_reason text;
ALTER TABLE installation ADD COLUMN mail_password_version integer NOT NULL DEFAULT 0;
UPDATE installation SET mail_password_version = coalesce((mail ->> 'passwordVersion')::integer, 0) WHERE id = 1;
