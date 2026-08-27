---
name: triage-scratch-backlog
description: Review the UNASSIGNED Backlog/To-Do issues in the Scratch Linear project against a focus-area priority list, report which ones fall outside those areas (cancellation candidates), then bulk- or selectively-cancel them — setting the Canceled status and adding a comment that names who ran the skill and notes it was cancelled by an agent. Use when the user wants to triage / prune / clean up / groom / review the Scratch Linear backlog to decide what to cancel while effort is being deprioritized.
user-invocable: true
allowed-tools:
  - mcp__linear__list_issues
  - mcp__linear__save_issue
  - mcp__linear__save_comment
  - mcp__linear__get_user
  - mcp__linear__list_teams
  - mcp__linear__list_projects
  - mcp__linear__list_issue_statuses
  - mcp__linear-server__list_issues
  - mcp__linear-server__save_issue
  - mcp__linear-server__save_comment
  - mcp__linear-server__get_user
  - mcp__linear-server__list_teams
  - mcp__linear-server__list_projects
  - mcp__linear-server__list_issue_statuses
  - AskUserQuestion
---

# Triage the Scratch backlog for cancellation

Loads the **unassigned** Backlog + To-Do issues in the **Scratch** project, reviews each against a
focus-area priority list (defaulted below, extendable by the user), reports the ones that fall
**outside** those areas as cancellation candidates, and — on the user's say-so — cancels them
(Canceled status + an attributed, agent-authored comment). Follow the steps in order.

> This skill only ever moves issues to **Canceled** and adds comments. It never edits descriptions,
> deletes issues, or touches assigned or non-Backlog/To-Do issues.

## Fixed values for this workspace

Stable ids — use directly; spot-check with a read-only call only if a write fails.

| Thing | Value |
| --- | --- |
| Team | `Dev` (id `b4e2b7f8-c4c2-4aaa-848c-e306f07c1a8f`) |
| Project | `Scratch` (id `41604a71-549f-4794-ab01-1b7f3b82d2dc`) |
| Status: Backlog | `81cb87fa-4a97-464c-afef-846b8c24c87f` (type `backlog`) |
| Status: To Do | `090a2059-cd19-4476-97c5-1174050a8017` (type `unstarted`) |
| Status: Canceled | `667007f5-572e-4222-98ac-3b2b201978b3` (type `canceled`) |

> ⚠️ There are decoy projects **`Scratch (Old)`** and **`Scratch User Tracker`**. Always target the
> exact project id `41604a71-549f-4794-ab01-1b7f3b82d2dc`, never a fuzzy name match.

> **Scope is the two named statuses `Backlog` and `To Do` only** — not the whole `backlog` *type*
> (which would also sweep in `Product design` and `Waiting for User`). Query each named status
> explicitly.

## Linear MCP tool names

Depending on how the Linear MCP is registered, its tools are exposed as either `mcp__linear__*`
(e.g. `mcp__linear__list_issues`) or `mcp__linear-server__*`. Use whichever prefix is present in
this session; the tool names after the prefix (`list_issues`, `save_issue`, `save_comment`,
`get_user`) are identical. Everywhere below, `<linear>` means that prefix.

## Default priority list (the "keep-active" focus areas)

An issue is **kept active** if it advances one of these. Everything else is a **cancellation
candidate**.

1. Stability of the job system & scheduling
2. Stability of scratch-git
3. Support for the Live Export feature in Whalesync
4. Major bugs in the sync engine
5. Performance issues with existing connectors
6. Security issues
7. Compliance issues
8. Data-loss bugs — any issue where user records, fields, or edits can be lost, corrupted, or
   silently dropped (e.g. a create that orphans a record, a pull that drops fields, a publish that
   silently discards an edit)

These are the defaults; Step 1 lets the user add to (or override) them before the review runs.

## Step 0 — Preflight: Linear connectivity + who is running this

1. Confirm the Linear MCP works with one cheap read-only call: `<linear>_list_teams({ "query": "Dev" })`.
   - If no `mcp__linear__*` / `mcp__linear-server__*` tools exist at all → tell the user the Linear
     MCP isn't configured for this session and stop.
   - If it errors with auth/permission (401/403, "unauthorized", token expired) → tell the user to
     re-authenticate the Linear MCP and stop.
2. Resolve **who is running the skill** (needed for the cancellation comment):
   `<linear>_get_user({ "query": "me" })` → keep the returned `name` as **RUNNER_NAME**. If it can't
   be resolved, ask the user for the name to attribute the run to before any cancellation.

## Step 1 — Confirm / extend the priority list

Show the user the 7 default focus areas (above) and ask, in a single `AskUserQuestion`:

- **"Add any priorities to keep active beyond the 7 defaults?"** Offer a few concrete options plus
  free-form (the `Other` option is automatic). Sensible options to present: `Use the 7 defaults as-is`,
  `Also keep every genuine bug (data-loss / correctness)`, `Also keep <specific area>`.

Record the final **keep-list** (defaults + any additions). If the user narrows or replaces the
defaults instead, honor that. Do not proceed to load issues until the keep-list is settled.

## Step 2 — Load the candidate issues (unassigned Backlog + To Do)

Make two calls (one per status), both filtered to **unassigned** (`assignee: "null"`):

```
<linear>_list_issues({ "project": "41604a71-549f-4794-ab01-1b7f3b82d2dc",
  "state": "Backlog", "assignee": "null", "limit": 250,
  "fields": ["title","priority","labels","status","assignee","url"] })

<linear>_list_issues({ "project": "41604a71-549f-4794-ab01-1b7f3b82d2dc",
  "state": "To Do", "assignee": "null", "limit": 250,
  "fields": ["title","priority","labels","status","assignee","url"] })
```

- `assignee: "null"` returns only unassigned issues — required (the skill never touches assigned work).
- If either response has `hasNextPage: true`, page with the returned `cursor` until exhausted.
- Merge the two result sets. This is the review population; report its total count.

## Step 3 — Classify each issue

For every loaded issue, decide **KEEP** (matches the keep-list) or **CANCEL CANDIDATE** (does not),
judging from the title + labels + priority. Use the description only if the title is genuinely
ambiguous (fetch it sparingly). Guidelight:

- A connector/service name, `[core]`, `scratch-git`, `[Live Export]`, `Sync engine bug`, `Security`,
  `Compliance` etc. in the title/labels usually maps straight to a keep area.
- New-connector requests, web/desktop UI features, cosmetic polish, test/CI infra, docs/tech-debt,
  and product features are typical cancel candidates.
- **High / Urgent priority ⇒ extra scrutiny, lean KEEP.** Treat `High` (2) and `Urgent` (1) issues
  as keep-by-default. Only mark one a cancel candidate if it clearly advances **none** of the keep
  areas **and** carries no data-loss / correctness risk — and state the justification. When in doubt
  on a High/Urgent issue, KEEP it.
- **Flag (⚠), don't silently cancel**, any candidate that is High/Urgent priority or implies data
  loss / data corruption / silent failure. These deserve a human's eyes even when outside the keep
  areas. (Note: with focus area 8 — *data-loss bugs* — a genuine data-loss issue is now a KEEP, not a
  flagged candidate; the ⚠ flag remains for the borderline/High cases that don't clearly qualify.)

## Step 4 — Present the report

Produce a scannable Markdown report:

1. **Summary** — population size, # KEEP, # CANCEL candidates, # flagged ⚠.
2. **KEEP** — table (`Issue`, `Pri`, matched focus area). Grouped by area.
3. **CANCEL candidates** — grouped by theme (new connectors, UI/features, test/CI, tech-debt, …),
   each row `Issue · Pri · short title`. Put a **⚠ Confirm-first** callout listing the flagged ones.
4. **Flat cancel-id list** — comma-separated identifiers, for easy bulk selection.
5. **Scrutiny callout** — count how many cancel candidates are **High/Urgent priority** or
   **data-loss / correctness** bugs, and if that count is non-zero, say so prominently and
   **recommend re-running Step 1 with a "keep every genuine bug" / data-loss extension before
   cancelling anything** (e.g. "8 of 29 candidates are High or data-loss — review these before any
   bulk action"). This is the moment to steer the user away from over-cancelling.

State plainly that **nothing has been changed yet**.

## Step 5 — Ask how to cancel

Single `AskUserQuestion`:

- **"How do you want to proceed?"** Options: `Bulk-cancel all candidates`, `Select which to cancel`,
  `Cancel nothing (report only)`.

**Discourage bulk-cancel when the ⚠ set is non-trivial.** If any candidates are flagged ⚠ (High/Urgent
or data-loss / correctness), do **not** present `Bulk-cancel all candidates` as the recommended
option — recommend `Select which to cancel` instead and warn that a bulk sweep would take the flagged
items with it. Only lead with bulk when the ⚠ set is empty. Never bulk-cancel a High/Urgent issue
without the user confirming it specifically.

If **Select**, get the specific identifiers from the user (they can reply with a list). If **Report
only**, stop after the report. Only proceed to Step 6 for the confirmed set.

## Step 6 — Execute the cancellations

For each confirmed issue, in this order:

1. **Re-verify scope** — the issue must still be in `Backlog` or `To Do` and still unassigned. If it
   moved or got assigned since Step 2, **skip it** and note the skip (state may have changed). This
   keeps the skill safe to re-run.
2. **Add the comment** (author is the authenticated Linear user automatically; the body also names
   the runner and flags the agent):

   ```
   <linear>_save_comment({ "issueId": "DEV-####", "body": "<CANCELLATION_COMMENT>" })
   ```

3. **Set Canceled**:

   ```
   <linear>_save_issue({ "id": "DEV-####", "state": "Canceled" })
   ```

Comment before status so the rationale is on record even if the status write is interrupted.
Independent issues can be processed in parallel. On a per-issue error, record it and continue; never
abort the whole batch for one failure.

### CANCELLATION_COMMENT format

Must (a) name **RUNNER_NAME** (who ran the skill) and (b) state it was cancelled by an agent. Use:

```
🤖 Cancelled by an agent (triage-scratch-backlog skill) on behalf of RUNNER_NAME, as part of the
Scratch backlog deprioritization review — this issue falls outside the active focus areas. Reopen
if this was cancelled in error.
```

If the user gave a more specific reason for a group (e.g. "deprioritizing new connector work"),
prepend or substitute that sentence, but keep the agent + RUNNER_NAME attribution.

## Step 7 — Report the result

Reply with a table: each processed issue → `Canceled ✅` (with the comment posted) or `Skipped`
(with the reason, e.g. "no longer in Backlog"). Give the running total cancelled and, if useful,
re-run the Step 2 queries to confirm the remaining unassigned Backlog/To-Do set.

## Guardrails

- **Never touch assigned issues or non-Backlog/To-Do issues** — the load filter enforces this;
  re-verify at cancel time (Step 6.1).
- **Only two mutations**: move to `Canceled` and add a comment. No description edits, no deletes.
- **Every cancellation is attributed** — RUNNER_NAME + the agent note — so it's always clear who ran
  the sweep and that it was automated. Cancels are reversible; say so in the comment.
- **When unsure whether something matches a keep area, keep it** and surface it as a ⚠ flag rather
  than cancelling. False keeps are cheap; a wrongly-cancelled real bug is not.
- **High/Urgent priority issues lean KEEP and get extra scrutiny** — never bulk-cancel them; require
  the user to confirm each one specifically. A wrongly-cancelled High/Urgent issue is the worst
  outcome this skill can produce.
- **Data-loss bugs are a keep area (focus area 8)** — any issue that can lose, corrupt, or silently
  drop user records/fields/edits stays active by default, regardless of priority.
