-- Spec B6 «Wiki» (review of PR19): the history and the log say why a change was made. A proposal keeps
-- its reasons where it always did (each operation's, and the proposal's own); a curator's change by hand
-- and a restore had theirs nowhere: it is kept with the revision and the log line they left.
ALTER TABLE page_revisions ADD COLUMN reason text CHECK (reason IS NULL OR length(reason) <= 2600);
ALTER TABLE wiki_log ADD COLUMN reason text CHECK (reason IS NULL OR length(reason) <= 2600);
