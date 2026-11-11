-- Spec v0.6 «Escritura directa»: a key with the permission writes to the wiki at once. Its revisions and its line
-- in the log say so (kind 'write'), with the key that wrote it, named as it was then; and whether it was a
-- maintenance pass (the daily cleanup, spec v0.6 «Limpieza diaria»), as an approved maintenance proposal's line does.
ALTER TABLE wiki_log DROP CONSTRAINT wiki_log_kind_check;
ALTER TABLE wiki_log ADD CONSTRAINT wiki_log_kind_check
  CHECK (kind IN ('proposal', 'direct', 'revert', 'purge', 'import', 'write'));
ALTER TABLE page_revisions DROP CONSTRAINT page_revisions_kind_check;
ALTER TABLE page_revisions ADD CONSTRAINT page_revisions_kind_check
  CHECK (kind IN ('proposal', 'direct', 'revert', 'purge', 'import', 'write'));
ALTER TABLE wiki_log
  ADD COLUMN credential_id text,
  ADD COLUMN key_name text CHECK (key_name IS NULL OR length(key_name) <= 200),
  ADD COLUMN maintenance boolean NOT NULL DEFAULT false;
-- A maintenance proposal: the cleanup an agent sends for a person to approve.
ALTER TABLE proposals ADD COLUMN maintenance boolean NOT NULL DEFAULT false;
-- The last cleanup of a brain, read at the start of every session.
CREATE INDEX wiki_log_maintenance ON wiki_log (brain_id, at DESC) WHERE maintenance;
