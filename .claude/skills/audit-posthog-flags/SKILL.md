---
name: audit-posthog-flags
description: Audit Scratch's PostHog feature flags for ones needing human re-evaluation — fully rolled-out flags that aren't kill switches, dead or unreferenced flags, flags targeted to a small user set or @whalesync.com only, and small-percentage rollouts that look stale. Cross-references the code flag enums with the PostHog MCP and reports each flag's PostHog creation info, recent $feature_flag_called exposure, and the developer who added it. Read-only — recommends, never changes a flag. Use when the user wants to review, audit, or clean up PostHog feature flags, or asks which Scratch flags are stale or need re-evaluation.
user-invocable: true
argument-hint: "[project: production|test|all — default production]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash(git log:*)
  - Bash(git blame:*)
  - AskUserQuestion
  - mcp__posthog__exec
---

# Audit PostHog flags for human re-evaluation

Cross-reference the PostHog feature flags declared in this repo's code enums with the live
PostHog configuration (via the PostHog MCP), find flags a human should re-evaluate, and produce
an inline report. This is **read-only**: it recommends, it never changes a flag.

Four things to surface:

1. Flags serving a single value to **100%** of users that are **not** kill switches or long-term
   knobs (cleanup candidates — the code path can be made permanent and the flag removed).
2. Flags **not referenced in code** or no longer powering any logic (dead).
3. Flags targeted to a **small set of users** or only to **`@whalesync.com`** emails.
4. Flags on a **small % rollout** that look **stale** — no recent `$feature_flag_called`
   exposure and/or an old, untouched enum entry (stalled ramp).

## Guardrails (read this first)

- **Strictly read-only.** The PostHog MCP is one dispatcher tool — `mcp__posthog__exec`. Only
  ever run `search` / `info` / `schema`, and `call` against **read-only** tools:
  `feature-flag-get-all`, `feature-flag-get-definition`, `project-get`, `read-data-schema`, and
  the `query-*` tools (to read `$feature_flag_called` exposure). **Never** `call` any mutating
  tool — no `create-feature-flag`, `update-feature-flag`, `delete-feature-flag`, and nothing
  matching `*-create` / `*-update` / `*-delete` / `*-launch` / `*-archive`. Prepare
  recommendations, not changes. If cleanup is wanted, hand the human a list; do not act on it.
- `switch-project` does not write to PostHog, but it changes which project subsequent reads hit
  — announce it and use it only to move between the Prod and Test inventories.
- The PostHog MCP suggests "prioritize skills over tools" and may offer to install agent skills.
  **This skill is the tooling — install nothing.**
- If the PostHog MCP is **not connected / authorized** in this session, say so and stop — there
  is no non-MCP fallback for live flag state. (It requires OAuth; the user authorizes it via
  `/mcp` in an interactive session.)
- Reading PostHog is not a `gcloud` / DB / production-infra command — it does not touch the
  GCP/production guardrails.
- This complements — it does **not** replace — the **`scratch-posthog`** skill, which is the
  **write** path (create/update/delete flags). Cross-reference it for the MCP call protocol,
  project ids, and naming conventions.

## Arguments

**Optional** — the target project (`production`, `test`, or `all`). If omitted, ask (Step 0),
defaulting to production. PostHog has no LaunchDarkly-style environment axis; "project" is the
axis (see Key facts).

## Key facts — code side

**Both flag enums live in one file** —
[`server/src/experiments/flags.ts`](../../../server/src/experiments/flags.ts):

| Enum | Scope | PostHog distinct id used |
| --- | --- | --- |
| `SystemFeatureFlag` (5 members) | system / org-wide | org id (`getBooleanFlagForOrg`) or `''` (no user) |
| `UserFlag` (14 members) | per user | `user.id` |

`AllFeatureFlags = SystemFeatureFlag | UserFlag`.

- **The PostHog flag key is the enum member's right-hand string VALUE, verbatim** — always match
  on the value, not the identifier. Every `UserFlag` value currently equals its identifier, but
  that is a coincidence, not a rule: **two `SystemFeatureFlag` values are lowercased and differ**
  — `SAMPLE_SYSTEM_FLAG` → `'sample_system_flag'` and `DESKTOP_DIRTY_GATE_ENABLED` →
  `'desktop_dirty_gate_enabled'`. Read the value anyway.
- **Client-exposed subset:** `ClientUserFlags` (`Partial<Record<UserFlag, FlagDataType>>`, where
  `FlagDataType = 'boolean' | 'string' | 'number' | 'array'`) lists the flags sent to the client
  on `/users/current`. Today it holds 7 boolean flags: `DEV_TOOLBOX`, `ENABLE_CREATE_BUG_REPORT`,
  `SHOW_OPEN_IN_DESKTOP`, `ENABLE_GENERIC_CONNECTOR`, `ENABLE_PUBLISH_HISTORY`,
  `ENABLE_SCRATCH_FOLDERS`, `DESKTOP_REVIEW_SURFACE_V2`. It is mirrored 1:1 by the
  `UserExperimentFlags` interface in
  [`packages/shared-types/src/db/user.ts`](../../../packages/shared-types/src/db/user.ts). The
  remaining 7 `UserFlag` members are **server-only** and deliberately absent from that map.
  `MINIMUM_SUPPORTED_DESKTOP_VERSION` rides a separate `User.minimumDesktopClientVersion` field,
  intentionally not in the triple.
- **No comment bands** group the flags. Kill-switch / long-term-knob / launch semantics live in
  **per-member doc comments** instead. All flags are positive-polarity `ENABLE_X` / `_ENABLED`
  (there are **no** `DISABLE_X` flags), so TRUE turns the gated behavior on and FALSE (default)
  preserves the old behavior.
- **Convention gotcha** ([`server/src/experiments/README.md`](../../../server/src/experiments/README.md)):
  do NOT set "Persist flag across authentication steps" on a PostHog flag — it hides the flag
  from the SDK (`FlagNotFoundError`). Not something the audit changes, but worth noting if seen.

**Kill-switch / long-term-knob signals** (used to *exclude* from scenario 1 — PostHog has no
`temporary` field, so infer from the code doc comment). Treat a flag as a **knob / kill switch**
(not a scenario-1 cleanup candidate) when its doc comment says any of: `kill switch`,
`break-glass`, `Global kill switch`, `opt-in gate + kill switch`, `release valve`, or describes
an operational enforcement toggle (a cron/enforcement that a human flips off in an incident).
Corroborating hints: `Fail-open` phrasing, a `DEV-####` ticket describing an operational gate,
and the `_ENABLED` suffix on a `SystemFeatureFlag` (e.g. `DESKTOP_DIRTY_GATE_ENABLED`,
`SUBSCRIPTION_ENFORCEMENT_ENABLED`). A plain `ENABLE_X` launch gate with `Fail-closed: default
false` and no kill-switch wording **is** a scenario-1 candidate once fully rolled out.

## Key facts — what counts as a genuine reference (dead-flag detection)

A flag **powers logic** iff one of these holds:

1. **Server reader call site** — `experimentsService.{getBooleanFlag | getBooleanFlagForOrg |
   getStringFlag | getNumberFlag | getJsonFlag}(FLAG, default, …)` where `FLAG` is an enum member
   (grep `UserFlag.<NAME>` / `SystemFeatureFlag.<NAME>` **outside** `flags.ts`), or a domain
   wrapper whose result feeds a branch: `isGenericConnectorEnabledForUser` (→
   `ENABLE_GENERIC_CONNECTOR`), `getMinimumSupportedDesktopVersion` (→
   `MINIMUM_SUPPORTED_DESKTOP_VERSION`).
2. **Connector capability call site — raw string literal** `isFeatureEnabled('<FLAG_VALUE>')`
   inside `server/src/remote-service/connectors/**`. These **never touch the enum** — the
   connector capability type is `isFeatureEnabled: (flagKey: string) => Promise<boolean>`.
   Current examples: `ENABLE_AFFINITY_WRITE`, `HUBSPOT_ASSOCIATIONS_API_2026_03`,
   `HUBSPOT_BATCH_PUBLISH`. **You must grep the string VALUE** for these, or they false-positive
   as dead.
3. **Client / desktop gate** — `isExperimentEnabled('<FLAG>', user)` or a direct
   `user.experimentalFlags?.<FLAG>` read that gates rendering/behavior. Client helper:
   [`client/src/types/server-entities/users.ts`](../../../client/src/types/server-entities/users.ts);
   desktop helper: `scratch-desktop/src/renderer/src/types/user.ts`.
4. **A hand-written special-case branch** in `resolveClientFeatureFlagsForUser` — only
   `DEV_TOOLBOX` (role-based) and `ENABLE_SCRATCH_FOLDERS` (environment-based) qualify.

**Do NOT count** (declaration / mirror / transport / dead):

- The enum declaration in `flags.ts` and membership in `ClientUserFlags`.
- The generic `for (…of Object.entries(ClientUserFlags))` sweep in
  `resolveClientFeatureFlagsForUser` — it reads every client flag purely to build the
  `/users/current` payload (transport, not logic).
- The `UserExperimentFlags` key in `packages/shared-types/src/db/user.ts` (a wire-shape mirror).
- Generic display loops — `Object.entries(user.experimentalFlags).map(...)` in the settings /
  dev-tools pages — and the desktop e2e harness that seeds `experimentalFlags` (a test mock).
- **Commented-out reads** — e.g. desktop `WorkspaceSidebar.tsx` has
  `const publishHistoryEnabled = true; // isExperimentEnabled('ENABLE_PUBLISH_HISTORY', …)`.
- The CLI (`scratch-git-2/src/cli`) reads no feature flags at all.

Two traps to remember: a live flag may have **zero `UserFlag.` references** (connector
raw-string flags), and a `ClientUserFlags` member always shows ≥1 hit from the generic loop +
the mirror even when nothing reads it. `SAMPLE_SYSTEM_FLAG` (`'sample_system_flag'`) currently
has no consumer anywhere — the clearest dead example.

## Key facts — PostHog side

- **Projects (this is the "environment" axis):** **Scratch - Prod = `214130`**,
  **Scratch - Test = `225935`** (local dev and the deployed test env both point at Test). The two
  projects are fully independent — a flag exists per project, keyed by `key`; the numeric `id`
  differs between projects, so reconcile by `key`, never by `id`. Dashboard URL:
  `https://us.posthog.com/project/<project_id>/feature_flags/<flag_id>`.
- **MCP call protocol (mandatory order):** `search <regex>` → `info <tool>` →
  `schema <tool> <field>` (only for `hint`-marked fields) → `call <tool> <json>`. Always re-run
  `info` before a `call` — schemas drift. `project-get` echoes the active project; the MCP only
  reports its project context on `switch-project` / `project-get`, so switch explicitly.
- **Read-only flag tools:**
  - `feature-flag-get-all` — the per-project inventory (`{"search": "<key>"}` to look one up, or
    unfiltered to list). Yields `key`, `active`, `id`, `name`.
  - `feature-flag-get-definition` — per-flag detail, including `filters` and (confirm the exact
    field names with `info` at runtime) creation info like `created_at` / `created_by`.
- **Release conditions** live in `filters.groups[]` (OR semantics across groups). Each group has
  its own `rollout_percentage` (0–100) and `properties[]` of `{key, type, operator, value}`.
  Empty `properties: []` ⇒ the group applies to the whole rollout %. Multivariate flags carry
  `filters.multivariate.variants[]`; payload-bearing flags carry `filters.payloads`. Unset
  `filters` ⇒ the flag returns false for everyone.
- **The `active` toggle** only controls whether PostHog evaluates the flag; a feature is killed
  via release conditions (0% / scoped away), not by toggling `active` off (off ⇒ `null` ⇒ server
  falls back to the `defaultValue`).
- **No native "last-modified" timestamp** exists on a PostHog flag object, and the MCP has no
  equivalent of LaunchDarkly's `find-stale-flags` / `check-removal-readiness` /
  `query-change-history` / `get-flag-health`. Staleness is judged from `$feature_flag_called`
  exposure + git-age (below).

## PostHog scenario classifier (all derivable from `filters` + `active` + code)

- **1 · 100%, not a kill switch:** `active: true` AND some group with `properties: []` and
  `rollout_percentage: 100`. **Drop** any flag classified as knob/kill switch in the code
  (per-member doc comment). What remains = fully rolled-out launch flags → remove-the-flag
  candidates.
- **2 · dead / unreferenced:** flag `key` present in PostHog but absent from both enums in
  `flags.ts`, OR an enum member with no genuine reference (rules above). Corroborate with
  near-zero recent `$feature_flag_called` exposure.
- **3 · small user set / `@whalesync.com`:** groups whose `properties[]` include `key: 'email'`
  matching `@whalesync.com` (operator `exact` or `icontains` — match on `key === 'email'` and
  classify by operator/value rather than assuming one operator) or a small enumerated
  `distinct_id` set, with **no** unfiltered 100% group. For `SystemFeatureFlag`, remember the
  distinct id is the org id, not a user id.
- **4 · small % rollout, stale:** a group with `properties: []` and `rollout_percentage` between
  1 and 99, AND stale by the exposure/age signal below.

## Staleness signal — `$feature_flag_called` exposure

PostHog fires a `$feature_flag_called` event (property `$feature_flag = <key>`) each time a flag
is evaluated. Use it as the primary "dead-in-practice / stalled ramp" signal:

1. `search query|trends|events` to find the read-only query tool, `info` it, then `schema` the
   `series` / filter fields before constructing the call (these schemas are large and `hint`-heavy).
2. Query `$feature_flag_called` counts for the flag key over the last **28 days** (the scenario-4
   cutoff = today − 28d). Optionally break down by the `$feature_flag_response` property to see
   the served value distribution.
3. Near-zero recent exposure ⇒ dead-in-practice (scenario 2) or a stalled ramp (scenario 4).
   Note when the event volume is too low to be conclusive rather than over-claiming.

## Git-age proxy + "who added it"

PostHog has no reliable last-modified time, so use git for the age proxy and enum authorship.
Pickaxe the introducing commit, **scoped to the enum file** so call sites don't match:

```bash
git log -S '<MEMBER>' --format='%h %an %ae %ad %s' --date=short \
  -- server/src/experiments/flags.ts | tail -1
```

The oldest match is the introduction. Pickaxe on the **identifier** (left-hand side) for the 14
`UserFlag` members; pickaxe on the **quoted value** (`-S "'sample_system_flag'"`) for the two
lowercase system flags where name ≠ value. Prefer `-S … | tail -1` over `git blame -L` (blame
reports the last toucher, not the introducer).

## Step 0 — Project

If a project argument was passed, use it. Otherwise `AskUserQuestion` offering **Production
(default)** / Test / All. Confirm the active project with `project-get` and `switch-project` as
needed (expect Prod `214130`). For `all`, run Steps 2–5 per project and label every row with the
project.

## Step 1 — Build the code-side flag index (local: Read / Grep / Glob)

1. Read `flags.ts` and parse both enums into a map
   `posthogKey (right-hand value) → { enum, member, line, docComment }`. Keep each member's
   inline doc comment.
2. **Classify** each flag as knob/kill switch vs launch flag using the doc-comment signals in
   Key facts. Record the deciding signal so the report can explain it.
3. Build the **reference index** for dead-flag detection, applying the genuine-reference rules:
   - `Grep` `UserFlag.<MEMBER>` / `SystemFeatureFlag.<MEMBER>` across `server/src` (outside
     `flags.ts`), and the two domain wrappers.
   - `Grep` each member's **string VALUE** across `server/src/remote-service/connectors/**`
     (connector raw-string flags).
   - `Grep` `isExperimentEnabled('<MEMBER>'` and `experimentalFlags?.<MEMBER>` across
     `client/src` and `scratch-desktop/src` — excluding commented-out lines and the generic
     display loops.
   - **Do not count** the declaration, `ClientUserFlags` membership, the generic
     `resolveClientFeatureFlagsForUser` sweep, the `UserExperimentFlags` mirror, or the e2e
     harness. Any *other* real reference ⇒ the flag is live.
4. Record the `ClientUserFlags` member set and the `UserExperimentFlags` field set for the
   **triple-sync check** in Step 3.

## Step 2 — Pull the PostHog inventory (per chosen project)

- `switch-project` to the target, then `feature-flag-get-all` to enumerate every flag with its
  `key`, `active`, and `id`. Paginate/search as the tool's `info` schema requires.
- `feature-flag-get-definition` for the **candidate subset only** (not all flags) — the flags
  Step 1 or the inventory diff flags for a deep dive — to get `filters` and creation info. This
  keeps call volume down; if the candidate set is large, say so.

## Step 3 — Reconcile code ↔ PostHog

Diff the code key set (Step 1) against the PostHog key set (Step 2):

- **In code, absent from PostHog** → typo, rename, or never-created key. Report as a code-hygiene
  note.
- **In PostHog, absent from code** → orphaned in PostHog; combined with Step 1's reference index,
  this is the core of scenario 2.
- **In both** → carry into Step 4.
- **Triple-sync note (code hygiene):** flag any drift in the `UserFlag` → `ClientUserFlags` →
  `UserExperimentFlags` triple — a `ClientUserFlags` member missing from the shared-types
  `UserExperimentFlags` interface (or vice-versa), or a client-typed flag that is actually
  server-only. This is a code bug even when PostHog is fine.

## Step 4 — Classify into the four scenarios

Deep-dive (`feature-flag-get-definition` + the exposure query) only the **candidate subset**.
Apply the PostHog scenario classifier above. Be conservative on scenario 1: when a fully
rolled-out flag is ambiguous (looks like a knob but isn't clearly one), list it and note the
ambiguity rather than hiding it — a human decides.

## Step 5 — Enrich each flagged flag

- **PostHog creation info** — `created_at` / `created_by` from `feature-flag-get-definition`
  (confirm the field names via `info`). Note when unavailable.
- **Recent exposure** — the `$feature_flag_called` count / last-seen over the last 28 days.
- **Who added it + age** — the git pickaxe above (introduction date + author). When the git
  author and PostHog `created_by` differ, report both; say when either is unknown rather than
  guessing.

## Report format

Inline markdown. Open with a one-line summary: project(s) analyzed, total flags reconciled, and
the count per scenario. Then one `###` section per scenario, each a table; **skip empty
sections**. Suggested columns:

- **1 · Fully rolled out (not kill switch):** Flag key · Enum·member · Project · Serving ·
  Created · Added by · Recent exposure · Recommendation.
- **2 · Dead / unreferenced:** Flag key · In code? · In PostHog? · Real references (count /
  where) · Recent exposure · Created · Added by · Recommendation.
- **3 · Small user set / @whalesync.com:** Flag key · Enum·member · Project · Targeting (e.g.
  `email icontains @whalesync.com`, or N `distinct_id` targets) · Created · Added by.
- **4 · Small % rollout, stale:** Flag key · Enum·member · Project · Rollout % · Recent exposure
  (28d) · Enum-entry age · Created · Added by.

Close with **reconciliation notes** (code keys missing from PostHog; PostHog keys missing from
code; triple-sync drift) and a short "act on these first" list of the few highest-value flags.

## Important guidelines

- **Be precise about the key.** Match on the enum value (right-hand side), not the identifier,
  because two system flags lowercase their value. A mismatch here silently drops or
  mis-attributes flags.
- **Grep the string value across connectors.** A connector-only flag (`ENABLE_AFFINITY_WRITE`,
  `HUBSPOT_*`) has no `UserFlag.` reference — greping only the enum member false-positives it as
  dead.
- **Be conservative on scenario 1.** List ambiguous knob-vs-launch flags with the ambiguity
  noted; a human decides.
- **Attribute honestly.** "Added by" is the enum author from git; PostHog `created_by` can be
  someone else — report both when they differ, and say when either is unknown.
- **Read-only, always.** Never toggle, update, archive, or delete a flag. Output is a report.
