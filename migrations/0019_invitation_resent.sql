-- Fix of B6 PR25a: one new invitation link a minute, per invitation. When an invitation last got a new
-- link is kept on the invitation itself (its row is already locked while a new link is made), instead of
-- searching the audit trail by email.
ALTER TABLE invitations ADD COLUMN resent_at timestamptz;
