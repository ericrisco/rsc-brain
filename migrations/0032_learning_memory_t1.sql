-- Spec learning-memory, tranche 1 (plan §3.1): proposals that apply at once with parts that wait or come back,
-- «Review later» with an exact undo, protected pages, the write mode of each wiki, and the expiry of each type of
-- entry, computed when read. Every new column takes a constant default or now() when added, so PostgreSQL adds it
-- without rewriting the table; the only bulk update is on pages (what existed counts as reviewed, CA-U6).

-- Whether lifetimes of entries are well formed: an object whose keys are types of entry and whose values are whole days
-- from 1 to 3650, or null for never. The app checks it too (lapse.ts readLifetimes); this holds for every path in, an
-- import or a restore included. With its schema, so a copy restores under the empty search path of pg_restore (0025).
CREATE FUNCTION public.brain_lifetimes_ok(v jsonb) RETURNS boolean
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT pg_catalog.jsonb_typeof(v) = 'object' AND NOT EXISTS (
      SELECT 1 FROM pg_catalog.jsonb_each(v) AS e(k, d)
       WHERE e.k NOT IN ('decision', 'learning', 'attempt', 'correction', 'preference', 'fact', 'step', 'summary', 'note')
          OR NOT (pg_catalog.jsonb_typeof(e.d) = 'null'
                  OR (pg_catalog.jsonb_typeof(e.d) = 'number' AND e.d::text ~ '^[0-9]{1,4}$'
                      AND e.d::text::integer BETWEEN 1 AND 3650)))
  $$;

-- The write mode of a wiki (spec A4): «auto» applies agents' changes at once, «ask_first» is v0.7.15. How long each
-- type of entry lasts without use (spec B2), per brain: {type: days | null}, null for never; empty is the defaults.
ALTER TABLE wiki_settings
  ADD COLUMN write_mode text NOT NULL DEFAULT 'auto' CHECK (write_mode IN ('auto', 'ask_first')),
  ADD COLUMN entry_lifetimes jsonb NOT NULL DEFAULT '{}' CHECK (public.brain_lifetimes_ok(entry_lifetimes));

-- Protected pages (spec A3): no page is born protected (CA-A19). A page is «unreviewed» while its revision is past
-- the last one a person saw (spec A1); pages that existed passed through the old regime and count as reviewed.
ALTER TABLE pages
  ADD COLUMN protected boolean NOT NULL DEFAULT false,
  ADD COLUMN protected_by text REFERENCES accounts(id),
  ADD COLUMN protected_at timestamptz,
  ADD COLUMN reviewed_revision integer NOT NULL DEFAULT 0;
UPDATE pages SET reviewed_revision = revision;

-- A proposal may now be applied whole, applied in part (some parts wait) or come back whole (every part was written on
-- an old revision). Its parts: applied, waiting with a reason, back with the revision of today, or undone.
ALTER TABLE proposals DROP CONSTRAINT proposals_status_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
  CHECK (status IN ('pending', 'approved', 'partially_approved', 'returned', 'withdrawn', 'superseded',
                    'applied', 'partially_applied', 'stale'));
ALTER TABLE proposal_ops DROP CONSTRAINT proposal_ops_status_check;
ALTER TABLE proposal_ops ADD CONSTRAINT proposal_ops_status_check
  CHECK (status IN ('pending', 'approved', 'returned', 'applied', 'stale', 'undone'));
ALTER TABLE proposal_ops
  ADD COLUMN hold_reason text CHECK (hold_reason IN ('protected', 'correction', 'ask_first', 'depends')),
  ADD COLUMN stale_current integer;

-- The log and the revisions of an undo; the log line of protecting or unprotecting a page (no revision).
ALTER TABLE wiki_log DROP CONSTRAINT wiki_log_kind_check;
ALTER TABLE wiki_log ADD CONSTRAINT wiki_log_kind_check
  CHECK (kind IN ('proposal', 'direct', 'revert', 'purge', 'import', 'write', 'undo', 'protect'));
ALTER TABLE page_revisions DROP CONSTRAINT page_revisions_kind_check;
ALTER TABLE page_revisions ADD CONSTRAINT page_revisions_kind_check
  CHECK (kind IN ('proposal', 'direct', 'revert', 'purge', 'import', 'write', 'undo'));
-- The change a log line belongs to, to read it from the log. Not a link: the change points at its log line.
ALTER TABLE wiki_log ADD COLUMN change_id text;

-- «Review later» (spec A1, A2): every change to the wiki that a person in the web did not make. Who, with which key
-- (named as it was then), from which session or run (the ref of a short key), and how it ended.
CREATE TABLE wiki_changes (
  id            text PRIMARY KEY,
  brain_id      text NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
  log_id        text NOT NULL REFERENCES wiki_log(id) ON DELETE CASCADE,
  proposal_id   text REFERENCES proposals(id) ON DELETE SET NULL,
  actor_id      text NOT NULL REFERENCES accounts(id),
  credential_id text NOT NULL,
  key_name      text CHECK (key_name IS NULL OR length(key_name) <= 200),
  ref           text CHECK (ref IS NULL OR length(ref) <= 200),
  session_id    text,
  created_at    timestamptz NOT NULL,
  state         text NOT NULL DEFAULT 'pending_review'
                CHECK (state IN ('pending_review', 'kept', 'undone', 'partly_undone')),
  decided_by    text REFERENCES accounts(id),
  decided_at    timestamptz,
  comment       text CHECK (comment IS NULL OR length(comment) <= 2600),
  undo_log_id   text REFERENCES wiki_log(id) ON DELETE SET NULL
);
CREATE INDEX wiki_changes_tray ON wiki_changes (brain_id, state, created_at, id);

-- Each page a change touched, with what it was before, so an undo puts back exactly that (spec A2, CA-A26): a merge
-- or a move changes addresses and incoming links of other pages without a revision there. Never the text of a page:
-- that stays in page_revisions, where a purge reaches it.
CREATE TABLE wiki_change_parts (
  change_id            text NOT NULL REFERENCES wiki_changes(id) ON DELETE CASCADE,
  part                 integer NOT NULL CHECK (part >= 0),
  op_index             integer,
  page_id              text NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  created              boolean NOT NULL DEFAULT false,
  revision_before      integer,
  revision_after       integer NOT NULL,
  address_before       text,
  address_after        text NOT NULL,
  status_before        text,
  superseded_by_before text,
  addresses_before     jsonb NOT NULL DEFAULT '[]',
  addresses_added      jsonb NOT NULL DEFAULT '[]',
  links_in_before      jsonb NOT NULL DEFAULT '[]',
  sources_added        jsonb NOT NULL DEFAULT '[]',
  state                text NOT NULL DEFAULT 'applied' CHECK (state IN ('applied', 'undone')),
  undone_by_person     boolean NOT NULL DEFAULT false,
  undo_revision        integer,
  PRIMARY KEY (change_id, part)
);
CREATE INDEX wiki_change_parts_page ON wiki_change_parts (page_id);

-- When the expiry of an entry starts to count (spec B2): its creation from now on, a new revision of its topic, and
-- for what existed, the day of the upgrade (CA-U1: nothing disappears at once). now() is the time of the migration's
-- transaction, the same for every row, kept by PostgreSQL without rewriting the table.
ALTER TABLE entries ADD COLUMN lapse_from timestamptz NOT NULL DEFAULT now();

-- The days each type of entry lasts without use: the brain's own value when it has one (null: never), else the
-- defaults of the spec. With its schema, so a copy restores under the empty search path of pg_restore (0025).
CREATE FUNCTION public.brain_entry_days(entry_type text, overrides jsonb) RETURNS integer
  LANGUAGE sql IMMUTABLE PARALLEL SAFE
  AS $$
    SELECT CASE
      WHEN overrides IS NOT NULL AND overrides ? entry_type THEN (overrides ->> entry_type)::integer
      ELSE CASE entry_type
        WHEN 'step' THEN 7
        WHEN 'attempt' THEN 14
        WHEN 'summary' THEN 30
        WHEN 'note' THEN 30
        WHEN 'learning' THEN 60
      END
    END
  $$;
