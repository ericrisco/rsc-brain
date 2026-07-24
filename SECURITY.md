# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.** Report privately via GitHub's
[private vulnerability reporting](https://github.com/ericrisco/rsc-brain/security/advisories/new)
for this repository. Include a description, affected version/commit, and a reproduction if you
have one. We aim to acknowledge within 5 working days and to agree a disclosure timeline with
you before any public detail is shared.

## Supported versions

The project is pre-1.0 (`0.x`). Security fixes target `main`; there is no back-porting to
older `0.x` tags yet. This section will be tightened at the v1.0 release.

## Automated gates that run today

This is an honest inventory — it lists what actually runs, and what does **not** yet, so the
absence of a finding is never mistaken for proven coverage.

| Gate | Where | Status |
|---|---|---|
| Lint + format (`ruff`) | CI `quality` | ✅ runs on every PR/push |
| Strict typing (`mypy --strict`) | CI `quality` | ✅ |
| Tests + coverage (≥70%) | CI `quality` | ✅ |
| Dependency audit (`pip-audit`, SCA) | CI `sca` | ✅ — currently **no known vulnerabilities** (pytest is `9.1.1`, so PYSEC-2026-1845 does not apply) |
| AGPL license compatibility | CI `licenses` | ✅ |
| Data-service build + extension smoke | CI `integration` | ✅ (ephemeral compose) |
| SBOM (syft) + CVE scan (grype) | Release workflow | ✅ on release/tag |
| Actions pinned to full commit SHAs, least-privilege tokens | all workflows | ✅ (AUDIT-006) |
| Basic committed-secret guard | `pre-commit` (`detect-private-key`) + `.gitignore` boundary | ⚠️ **not** a full secret scanner |

### Not yet covered (planned)

- **Dedicated secret scanning** (e.g. gitleaks) over the working tree and git history.
- **SAST** (e.g. semgrep) in CI.

These land in the release-hardening SPEC (SPEC-22). Until then, "no committed secret was
found" means only that the basic guard and the ignore boundary passed — not that a full scan
ran.

## Secrets

Real credentials never enter git. They live in `.env` (gitignored) or Docker secrets, and the
application reads them from the environment only (`config.yaml`/`config.example.yaml` never
contain keys). See [`docker/README.md`](docker/README.md) for the data-service password guard.
