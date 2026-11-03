-- Spec B7 «Importar» (C17, plan §3.6): a brain can be filled from a documentation folder or from a faithful export
-- of another installation.
--
-- Someone named in a faithful export who has no account here comes in as an author: a name on what they wrote. An
-- author never signs in: no email, no password, no second factor, no administration, no key, no connection and no
-- membership, and an account never turns into one or out of one.
ALTER TABLE accounts DROP CONSTRAINT accounts_kind_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_kind_check CHECK (kind IN ('person', 'service', 'author'));
ALTER TABLE accounts ADD CONSTRAINT accounts_author_inert CHECK (
  kind <> 'author' OR (
    email IS NULL AND password_hash IS NULL AND totp_secret IS NULL AND totp_pending IS NULL
    AND NOT is_admin AND NOT can_create_brains AND NOT can_invite
  )
);

CREATE FUNCTION brain_refuse_author() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE id = NEW.account_id AND kind = 'author') THEN
    RAISE EXCEPTION 'an imported author has no %', TG_ARGV[0] USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER memberships_no_author BEFORE INSERT OR UPDATE OF account_id ON memberships
  FOR EACH ROW EXECUTE FUNCTION brain_refuse_author('membership');
CREATE TRIGGER credentials_no_author BEFORE INSERT OR UPDATE OF account_id ON credentials
  FOR EACH ROW EXECUTE FUNCTION brain_refuse_author('key');
CREATE TRIGGER oauth_grants_no_author BEFORE INSERT OR UPDATE OF account_id ON oauth_grants
  FOR EACH ROW EXECUTE FUNCTION brain_refuse_author('connection');

CREATE FUNCTION brain_author_kind_fixed() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF (OLD.kind = 'author') <> (NEW.kind = 'author') THEN
    RAISE EXCEPTION 'an account does not become an imported author, nor stop being one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER accounts_author_kind BEFORE UPDATE OF kind ON accounts
  FOR EACH ROW EXECUTE FUNCTION brain_author_kind_fixed();

-- When a brain was filled by an import, and from what (a file or folder name, redacted).
ALTER TABLE brains
  ADD COLUMN imported_at timestamptz,
  ADD COLUMN imported_from text CHECK (imported_from IS NULL OR length(imported_from) <= 200);

-- An import is one change of the wiki: one line in its log, and the first revision of every page it brings.
ALTER TABLE wiki_log DROP CONSTRAINT wiki_log_kind_check;
ALTER TABLE wiki_log ADD CONSTRAINT wiki_log_kind_check
  CHECK (kind IN ('proposal', 'direct', 'revert', 'purge', 'import'));
ALTER TABLE page_revisions DROP CONSTRAINT page_revisions_kind_check;
ALTER TABLE page_revisions ADD CONSTRAINT page_revisions_kind_check
  CHECK (kind IN ('proposal', 'direct', 'revert', 'purge', 'import'));
