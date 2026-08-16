import type { components } from "./schema";

/** Browser authority comes from the generated OpenAPI envelope, never a parallel UI model. */
export type Membership = components["schemas"]["SessionMembership"];
export type Me = components["schemas"]["SessionEnvelope"];

export type Pat = components["schemas"]["SelfPat"];
export type PatList = components["schemas"]["SelfPatList"];
export type CreatedPat = components["schemas"]["CreatedPat"];
export type RevokedPat = components["schemas"]["RevokedPat"];

// --- SPEC-14 read observability -------------------------------------------------------------

export type Activity = components["schemas"]["ActivityEnvelope"];
export type RecallRow = components["schemas"]["RecallView"];
export type RecallPage = components["schemas"]["ReadPage_RecallView_"];
export type Health = components["schemas"]["HealthEnvelope"];
export type PendingDoc = components["schemas"]["PendingDocumentView"];
export type PendingDocList = components["schemas"]["PendingDocumentEnvelope"];
export type IngestRun = components["schemas"]["IngestRunView"];
export type IngestError = components["schemas"]["IngestErrorView"];
export type Ingest = components["schemas"]["IngestEnvelope"];

// --- SPEC-19 living knowledge ---------------------------------------------------------------

export type Gap = components["schemas"]["GapView"];
export type GapList = components["schemas"]["GapEnvelope"];
export type Hunt = components["schemas"]["HuntView"];
export type HuntList = components["schemas"]["HuntEnvelope"];
export type DisputedClaim = components["schemas"]["DisputedClaimView"];
export type DisputedClaimList = components["schemas"]["DisputedClaimEnvelope"];
export type Resolution = components["schemas"]["ContradictionResolutionView"];
export type ResolutionList = components["schemas"]["ContradictionResolutionEnvelope"];
export type Correction = components["schemas"]["CorrectionView"];
export type CorrectionList = components["schemas"]["CorrectionEnvelope"];
export type CorrectionMetrics = components["schemas"]["CorrectionMetricsEnvelope"];
export type CorrectionRevertResult = components["schemas"]["CorrectionRevertResult"];

// --- SPEC-21 unified needs_review queue -----------------------------------------------------

export type ReviewItem = components["schemas"]["ReviewItemView"];
export type ReviewQueue = components["schemas"]["ReviewQueueEnvelope"];
export type ChunkReviewResolution = components["schemas"]["ChunkReviewResolution"];
export type MergeReviewResolution = components["schemas"]["MergeReviewResolution"];

// --- SPEC-26 console release ----------------------------------------------------------------

export type Usage = components["schemas"]["UsageEnvelope"];
export type UsageRow = components["schemas"]["UsageRowView"];
export type Audit = components["schemas"]["AuditEnvelope"];
export type AuditRow = components["schemas"]["AuditView"];

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

export type GraphNodeView = components["schemas"]["GraphNodeView"];
export type GraphEdgeView = components["schemas"]["GraphEdgeView"];
export type Neighborhood = components["schemas"]["EntityGraphEnvelope"];

// --- Control-plane governance ---------------------------------------------------------------

export type ProjectInventory = components["schemas"]["ProjectInventory"];
export type ProjectInventoryItem = components["schemas"]["ProjectInventoryState"];
export type ProjectState = components["schemas"]["ProjectState"];
export type ProjectEnvelope = components["schemas"]["ProjectEnvelope"];
export type ProjectTransition = components["schemas"]["ProjectTransition"];
export type ProjectImpact = components["schemas"]["ProjectImpact"];
export type ProjectDeleteResult = components["schemas"]["ProjectDeleteEnvelope"];

export type UserPage = components["schemas"]["UserPage"];
export type UserState = components["schemas"]["UserListState"];
export type InviteResult = components["schemas"]["InviteEnvelope"];
export type DisableResult = components["schemas"]["DisableEnvelope"];
export type PasswordResetResult = components["schemas"]["PasswordResetEnvelope"];
export type MembershipList = components["schemas"]["MembershipList"];
export type MembershipState = components["schemas"]["MembershipState"];
export type MembershipTransition = components["schemas"]["MembershipTransition"];
export type CredentialList = components["schemas"]["CredentialList"];
export type CredentialState = components["schemas"]["CredentialState"];
export type CredentialEnvelope = components["schemas"]["CredentialEnvelope"];

export type TopicList = components["schemas"]["TopicList"];
export type TopicState = components["schemas"]["TopicState"];
export type TopicEnvelope = components["schemas"]["TopicEnvelope"];
export type TopicTransition = components["schemas"]["TopicTransition"];

export type HuntCommand = components["schemas"]["HuntCommandView"];
export type Skill = components["schemas"]["SkillView"];
export type SkillList = components["schemas"]["SkillEnvelope"];
export type SkillCreateResult = components["schemas"]["SkillCreateResult"];
export type SkillCommand = components["schemas"]["SkillCommandView"];
