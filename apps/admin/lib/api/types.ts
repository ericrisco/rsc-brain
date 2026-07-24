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
