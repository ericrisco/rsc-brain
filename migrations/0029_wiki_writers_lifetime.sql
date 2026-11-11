-- Review of v0.6 (finding 6): the permission to write to a wiki does not outlive what it stood on. When its owner
-- drops below contributor in that brain or leaves it, when the owner's account stops being active, or when the
-- key (or the connection of an app) is revoked, the permission goes, for good: a later promotion or a reactivation
-- does not bring it back silently; a curator gives it again. Done in the database, so every path that changes a
-- membership, an account or a key does it, now and later.

-- The keys of an account: its tokens and main keys, and its connections.
CREATE FUNCTION public.brain_keys_of(account text) RETURNS SETOF text
  LANGUAGE sql STABLE
  AS $$ SELECT id FROM public.credentials WHERE account_id = account AND kind IN ('token', 'main')
        UNION ALL SELECT id FROM public.oauth_grants WHERE account_id = account $$;

CREATE FUNCTION public.brain_writers_on_membership() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' OR NEW.role NOT IN ('contributor', 'curator') THEN
    DELETE FROM public.wiki_writers
     WHERE brain_id = OLD.brain_id AND key_id IN (SELECT public.brain_keys_of(OLD.account_id));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER memberships_wiki_writers AFTER UPDATE OF role OR DELETE ON memberships
  FOR EACH ROW EXECUTE FUNCTION public.brain_writers_on_membership();

CREATE FUNCTION public.brain_writers_on_account() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'active' THEN
    DELETE FROM public.wiki_writers WHERE key_id IN (SELECT public.brain_keys_of(NEW.id));
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER accounts_wiki_writers AFTER UPDATE OF status ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.brain_writers_on_account();

CREATE FUNCTION public.brain_writers_on_revoke() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
    DELETE FROM public.wiki_writers WHERE key_id = NEW.id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER credentials_wiki_writers AFTER UPDATE OF revoked_at ON credentials
  FOR EACH ROW EXECUTE FUNCTION public.brain_writers_on_revoke();
CREATE TRIGGER oauth_grants_wiki_writers AFTER UPDATE OF revoked_at ON oauth_grants
  FOR EACH ROW EXECUTE FUNCTION public.brain_writers_on_revoke();

-- Those already left behind by such a change before this migration.
DELETE FROM wiki_writers w
 WHERE NOT EXISTS (
   SELECT 1 FROM memberships m JOIN accounts a ON a.id = m.account_id
     LEFT JOIN credentials c ON c.id = w.key_id LEFT JOIN oauth_grants g ON g.id = w.key_id
    WHERE m.brain_id = w.brain_id AND m.account_id = coalesce(c.account_id, g.account_id)
      AND m.role IN ('contributor', 'curator') AND a.status = 'active'
      AND coalesce(c.revoked_at, g.revoked_at) IS NULL);
