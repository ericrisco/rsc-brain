/**
 * App-level shapes for the JSON the console consumes. The request/path/verb contract is fully
 * typed from the generated OpenAPI (`schema.d.ts`) via `openapi-fetch`; these describe the
 * response bodies the bootstrap endpoints return. Tightening the API's response_model to make
 * these generated too is a follow-up — the drift-check already guards the whole contract.
 */

export interface Membership {
  project: string;
  role: "owner" | "project-admin" | "viewer" | "member";
  allowed_topics: string[];
  can_curate: boolean;
}

export interface Me {
  user: { id: string; email: string; role: string };
  is_owner: boolean;
  memberships: Membership[];
}

export interface Pat {
  id: string;
  name: string | null;
  project: string;
  created_at: string | null;
  expires_at: string | null;
  revoked: boolean;
}

export interface PatList {
  pats: Pat[];
}

export interface CreatedPat {
  pat_id: string;
  token: string;
}

// --- SPEC-14 read observability -------------------------------------------------------------

export interface Activity {
  recalls: number;
  denied: number;
  active_principals: number;
  p95_duration_ms: number | null;
  recalls_per_day: { day: string; recalls: number }[];
}

export interface RecallRow {
  id: number;
  ts: string | null;
  principal_type: string | null;
  principal_id: string | null;
  on_behalf_of: string | null;
  query_text: string | null;
  query_hash: string | null;
  topics_used: string[];
  result_count: number | null;
  duration_ms: number | null;
  denied: boolean;
}

export interface Health {
  database: string;
  pending_approval: number;
  ingest_errors: number;
}

export interface PendingDoc {
  document_id: string;
  title: string | null;
  proposed_tags: string[];
  source_id: string | null;
  preview: string;
}

export interface IngestRun {
  document_id: string;
  phase: string;
  completed_stages: string[];
  chunks_created: number;
  claims_generated: number;
  discarded_chunks: number;
  error: string | null;
}
