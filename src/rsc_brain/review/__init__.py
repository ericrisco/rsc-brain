"""The unified needs_review queue (SPEC-21, FR-13.6): one inbox over the four sources the system
parked as doubtful — ambiguous tables (FR-1.5), low-confidence entity merges (FR-1.9), quarantined
agent submissions (FR-14.4), and agent correction suggestions (FR-15.10) — plus guardrail-flagged
chunks (FR-4.4). This package aggregates them (read) and resolves them via each owning service.
"""
