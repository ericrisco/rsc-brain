-- Review of PR21 (spec B6 «Proposals», B2 «Historia» CA25). A purge rewrites the wiki's text in place and
-- keeps every revision number, so a revision cannot tell a person's edit written before a purge from one
-- written after. Each purge of the wiki counts here; a review shows the count, a correction echoes it, and
-- a correction written before the last purge is refused (it could put the purged text back).
ALTER TABLE brains ADD COLUMN wiki_purges integer NOT NULL DEFAULT 0;
