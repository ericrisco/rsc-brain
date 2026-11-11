// What a copy holds (plan §3.3, risk 2): every table of the schema is either here, with every column that is
// not generated, or in SKIP with the reason it is left out. test/ops/backup.test.ts compares both lists with
// the database after every migration, so a new table or column cannot be lost from copies in silence.
//
// The order is the order a restore loads them: a table comes after every table it points to, except the links
// named in LOAD_ORDER_EXCEPTIONS. A restore loads rows in batches, so a row may still come before the row it points to
// (in its own table, or across one of those exceptions): restore.ts checks every link at the end of loading, inside its
// transaction, and puts each back as it was. Rows go out in key order, so two copies of the same data are the same
// text.
export type BackupTable = { name: string; columns: string[]; order: string[] }

const t = (name: string, columns: string, order = 'id'): BackupTable => ({
  name,
  columns: columns.split(/\s+/).filter(Boolean),
  order: order.split(/\s+/),
})

export const BACKUP_TABLES: readonly BackupTable[] = [
  t(
    'installation',
    `id name public_url setup_done_at key_epoch curators_invite mail rate_limit logo logo_type logo_sha256
     logo_updated_at factory_url mail_password_version maintenance_until maintenance_reason`,
  ),
  t(
    'accounts',
    `id kind email name is_admin can_create_brains can_invite status created_at password_hash totp_secret
     totp_pending totp_last_step removed_at`,
  ),
  t(
    'brains',
    `id slug name description purpose status pending_curator_email created_by created_at updated_at wiki_purges
     imported_at imported_from`,
  ),
  t('oauth_clients', 'client_id kind name redirect_uris fetched_at created_at', 'client_id'),
  t(
    'oauth_grants',
    `id client_id client_name redirect_host account_id brain_ids perm refresh_hash epoch created_at last_used_at
     expires_max revoked_at`,
  ),
  t(
    'credentials',
    `id account_id kind name secret_hash last4 perm all_brains brain_ids write_brain_id read_brain_ids ref agent
     on_behalf_id parent_id created_at expires_at revoked_at last_used_at epoch last_client expiry_noticed_at
     grant_id`,
  ),
  t(
    'sessions',
    `id brain_id account_id credential_id bound purpose ref day status summary_entry_id opened_at
     last_activity_at closed_at client`,
  ),
  t(
    'entries',
    `id brain_id session_id type topic title content applies_to tags refs author_id credential_id on_behalf_id
     stamped_ref revision repeat_count norm_hash pinned review_after expires_at state forgotten_by
     forgotten_reason forgotten_at purged_by purged_reason purged_at superseded_by compiled created_at updated_at
     client`,
  ),
  t(
    'entry_revisions',
    `entry_id revision type title content applies_to tags refs author_id credential_id on_behalf_id stamped_ref
     created_at`,
    'entry_id revision',
  ),
  t(
    'relations',
    'id brain_id from_id to_id kind status reason created_by credential_id created_at decided_at',
  ),
  t(
    'proposals',
    `id brain_id title reason author_id credential_id agent status supersedes_id superseded_by collected comment
     decided_by decided_at last_error created_at purged_by purged_at purged_reason maintenance`,
  ),
  t(
    'proposal_ops',
    'proposal_id idx op status corrected_by base_reviewed_by applied_page applied_revision',
    'proposal_id idx',
  ),
  t(
    'pages',
    'id brain_id address type title summary body tags status superseded_by revision created_at updated_at',
  ),
  t('page_addresses', 'brain_id address page_id created_at', 'brain_id address'),
  t(
    'page_revisions',
    `page_id revision address type title summary body tags status sources links kind author_id credential_id
     proposal_id op_index corrected base_reviewed note created_at purged_by purged_at purged_reason reason`,
    'page_id revision',
  ),
  t('page_links', 'brain_id from_page kind to_page to_address', 'brain_id from_page kind to_address'),
  t('page_sources', 'page_id entry_id url title', 'page_id entry_id url'),
  t('memberships', 'brain_id account_id role created_at notify_proposals', 'brain_id account_id'),
  t('wiki_writers', 'brain_id key_id granted_by granted_at', 'brain_id key_id'),
  t(
    'invitations',
    `id email token_hash grants is_admin can_create_brains invited_by created_at expires_at used_at revoked_at
     account_id resent_at`,
  ),
  t('password_resets', 'token_hash account_id created_by created_at expires_at used_at', 'token_hash'),
  t('oauth_used_refresh', 'hash grant_id used_at', 'hash'),
  t('notices', 'id account_id at kind brain_id text read_at'),
  t('events', 'id brain_id at kind account_id credential_id ref target_id label query result_ids seq client'),
  t('trail', 'id brain_id at account_id credential_id ref kind query result_ids session_id'),
  t('trail_counts', 'brain_id target_id reads searches contexts until', 'brain_id target_id'),
  t(
    'wiki_log',
    'id brain_id at actor_id kind proposal_id summary pages reason credential_id key_name maintenance',
  ),
  t(
    'wiki_settings',
    `brain_id guide map_intro stale_days long_chars maintenance_every approvals_since usage_note meaning_excluded`,
    'brain_id',
  ),
  t(
    'meaning_settings',
    `id enabled provider model accepted_by accepted_at changed_at openai_key openai_key_last4 ollama_url
     destination off_reason`,
  ),
  t('meaning_vectors', 'kind target_id brain_id provider model text_hash vec updated_at', 'kind target_id'),
  t('meaning_failures', 'kind target_id brain_id attempts at', 'kind target_id'),
  t('repo_links', 'url_key brain_id added_by created_at', 'url_key brain_id'),
  t('audit', 'id at actor_id credential_id action brain_id target outcome detail'),
  t('mail_log', 'id at to_addr kind status error'),
]

// Left out of copies, each with why. A restore starts with these empty.
export const SKIP: Readonly<Record<string, string>> = {
  schema_migrations:
    'The header of the copy lists the migrations it was made at; a restore migrates up to that list, then on.',
  oauth_codes:
    'Single-use sign-in codes of the standard sign-in that live for minutes; a restore ends every key anyway.',
  login_brakes:
    'Counters of failed sign-ins that slow down guessing; they reset on their own and mean nothing elsewhere.',
  request_keys:
    'Receipts that make a retried write answer the same for minutes; a restore ends the keys they belong to.',
}

// Links between tables that point both ways, so no order loads both at once: a restore checks links only once every
// table is in.
export const LOAD_ORDER_EXCEPTIONS: ReadonlyArray<{ child: string; parent: string; column: string }> = [
  // A session points to the entry that summarises it; an entry points to its session.
  { child: 'sessions', parent: 'entries', column: 'summary_entry_id' },
]
