---
name: review-aggregate
description: Evaluate an aggregate code review document for red flags that need direct human review. Use weekly to triage Vanta non-compliant MRs from the spinner repo.
user-invocable: true
allowed-tools:
  - Read(**/aggregate-code-review.md)
  - Bash(git log:*)
  - Bash(git diff:*)
---

## Context

Whalesync uses Vanta for compliance. MRs that merge without an independent approval
are flagged by the `gitlab-code-change-approved-or-justified` test. Each week we
generate an `aggregate-code-review.md` file listing these MRs so they can be
reviewed in bulk and justified in Vanta.

This skill triages the list so a human reviewer can focus on the MRs that actually
need careful attention.

**Scope:** This skill only evaluates MRs from the [`whalesync/spinner`](https://gitlab.com/whalesync/spinner) and [`whalesync/scratch-www`](https://gitlab.com/whalesync/scratch-www)
repos. MRs from other repos (e.g., `whalesync/whalesync`, `whalesync/internal`) are
listed separately as out-of-scope and not triaged.

## Arguments

**Optional:**

1. **file_path**: Path to the aggregate review document. Defaults to `aggregate-code-review.md` in the repo root.

## Your task

Read the aggregate review document and identify MRs whose URL contains
`gitlab.com/whalesync/spinner`. Evaluate every spinner MR against the red-flag
criteria below. Produce a structured triage report. List all non-spinner MRs
together in a single out-of-scope section without evaluating them.

### Red-flag criteria

Flag an MR for human review if its title or description suggests any of the
following:

1. **Security** — CVE fixes, auth/authz changes, token/session handling, input
   validation, encryption, CORS, CSP, or dependency upgrades that patch a
   vulnerability.
2. **Git logic** — Changes to how scratch-git manages repose, branches, merges and data reconcillation
3. **Connector** - Modifications to connectors that change how they pull/publish data or construct schemas.
4. **Secrets, permissions, or access** — IAM role grants, service-account changes,
   secret rotation, API key handling, RBAC changes, or anything that widens access.
5. **Complex Terraform** — New resources (databases, buckets, networking),
   permission grants, reverts of infra changes, or environment-level feature
   flag flips. Simple variable or docs-only Terraform changes are fine.
6. **Data deletion** — Any new capability to delete or purge customer data, even
   behind dev-tools or feature flags.

### Output format

Produce a markdown report with the following sections:

#### 1. Red Flags — Needs Human Review

A table with columns: `#`, `MR` (linked title), `Author`, `Concern` (which
criterion it matched and a one-sentence explanation of why).

Group rows by criterion category. Within each category, order by severity (most
concerning first).

#### 2. Low Risk — Approve in Aggregate

A table with columns: `#`, `MR` (linked title), `Reason` (brief justification
for why it's safe, e.g., "docs only", "UI styling", "test cleanup").

#### 3. Out of Scope (non-spinner repos)

A table with columns: `#`, `MR` (linked title), `Repo`. No evaluation — just
list them so the reviewer can confirm nothing was missed.

#### 4. Summary

A short paragraph stating:

- Total spinner MRs reviewed (excluding out-of-scope)
- Count flagged for human review
- Count safe to approve in aggregate
- Count of out-of-scope MRs skipped
- The top 3 spinner MRs that most urgently need attention, with a one-line reason each

## Important guidelines

- **Scope is fixed to spinner**: Only evaluate MRs whose URL contains
  `gitlab.com/whalesync/spinner`. All other MRs go in the out-of-scope section
  without evaluation.
- **Be conservative**: When in doubt, flag for review. False positives are
  acceptable; false negatives are not.
- **Title is your primary signal**: You are triaging from MR titles only. If a
  title is ambiguous, flag it and note the ambiguity.
- **Don't fetch MR contents**: This is a title-based triage. Do not attempt to
  fetch or clone MR diffs.
- **Terraform reverts are always flags**: A revert of an infra change suggests
  something went wrong — always flag it. (Note: most Terraform changes live in
  the `whalesync/whalesync` repo and will be out-of-scope, but flag any that
  appear in spinner MRs.)
- **Dependency pins below a version are flags**: Pinning below a specific version
  may exclude security patches.
