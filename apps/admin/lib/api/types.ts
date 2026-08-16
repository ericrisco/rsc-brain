import type { components } from "./schema";

/** Browser authority comes from the generated OpenAPI envelope, never a parallel UI model. */
export type Membership = components["schemas"]["SessionMembership"];
export type Me = components["schemas"]["SessionEnvelope"];

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

// --- SPEC-19 living knowledge ---------------------------------------------------------------

export interface Gap {
  id: string;
  query_text: string | null;
  topics: string[];
  count: number;
  status: string;
  last_seen_at: string | null;
}

export interface Hunt {
  id: string;
  type: string;
  state: string;
  question: string | null;
  person_id: string | null;
  gap_id: string | null;
  correction_id: string | null;
  channel: string | null;
  retries: number;
  created_at: string | null;
  asked_at: string | null;
  answered_at: string | null;
  expires_at: string | null;
  resolved_at: string | null;
}

export interface DisputedClaim {
  id: string;
  text: string;
  tags: string[];
  credibility: number;
  valid_to: string | null;
}

export interface ResolutionSide {
  claim_id: string;
  text: string;
  credibility: number;
  valid_to: string | null;
}

export interface Resolution {
  verdict: string;
  confidence: number;
  judge_version: string;
  winner: ResolutionSide;
  loser: ResolutionSide;
  created_at: string | null;
}

export interface Correction {
  id: string;
  target_claim: string;
  new_claim: string | null;
  status: string;
  role_applied: string | null;
  author_id: string | null;
  on_behalf_of: string | null;
  hunt_id: string | null;
  before_text: string | null;
  after_text: string | null;
  created_at: string | null;
  resolved_at: string | null;
}

export interface CorrectionMetrics {
  total: number;
  by_status: Record<string, number>;
  applied: number;
  routed_hunt: number;
  rejected: number;
  revert_rate: number;
  correction_wars: number;
  ownership_coverage: number;
}

// --- SPEC-21 unified needs_review queue -----------------------------------------------------

export interface ReviewItem {
  source: string;
  id: string;
  preview: string;
  detail: Record<string, unknown>;
}

export interface ReviewQueue {
  items: ReviewItem[];
  counts: Record<string, number>;
}

// --- SPEC-26 console release ----------------------------------------------------------------

export interface UsageRow {
  capability: string;
  day: string;
  tokens: number;
  calls: number;
}

export interface AuditRow {
  id: string;
  ts: string | null;
  principal_type: string | null;
  principal_id: string | null;
  action: string | null;
  tool: string | null;
  query_hash: string | null;
  query_text: string | null;
  topics_used: string[];
  result_count: number | null;
  denied: boolean;
}

export interface AuditFilters {
  action?: string;
  tool?: string;
  principal_type?: string;
  principal_id?: string;
  denied?: boolean;
  since?: string;
  until?: string;
}

export type ProductMetrics = components["schemas"]["ProductMetricsEnvelope"];

export interface GraphNodeView {
  id: string;
  name: string;
  type: string;
  anchored: boolean;
}

export interface GraphEdgeView {
  source: string;
  target: string;
  type: string;
}

export interface Neighborhood {
  center: GraphNodeView;
  neighbors: GraphNodeView[];
  edges: GraphEdgeView[];
  total: number;
  offset: number;
  limit: number;
}
