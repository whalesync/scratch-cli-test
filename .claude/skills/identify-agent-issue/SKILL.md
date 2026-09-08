---
name: identify-agent-issue
description: Analyze the Scratch Linear project and pick one Backlog issue an agent can work on — the top eligible ticket (Agent label, unassigned, not Needs scoping, size XS/S/M; highest priority, tie-break oldest) — then review it for readiness, tagging Needs scoping and advancing past any ticket that isn't implementable without a developer, and report the ready DEV-#### to hand to /dev-issue. Read-only except the Needs-scoping tag/comment — it does NOT claim, branch, or implement. Use when the user wants an agent to find a ready backlog ticket, or to feed the selection half of automated backlog development.
user-invocable: true
argument-hint: "[DEV-#### | (empty = auto-select)]"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Task
  - mcp__linear__list_teams
  - mcp__linear__list_issues
  - mcp__linear__get_issue
  - mcp__linear__list_comments
  - mcp__linear__list_issue_labels
  - mcp__linear__list_issue_statuses
  - mcp__linear__get_user
  - mcp__linear__save_issue
  - mcp__linear__save_comment
  - mcp__linear-server__list_teams
  - mcp__linear-server__list_issues
  - mcp__linear-server__get_issue
  - mcp__linear-server__list_comments
  - mcp__linear-server__list_issue_labels
  - mcp__linear-server__list_issue_statuses
  - mcp__linear-server__get_user
  - mcp__linear-server__save_issue
  - mcp__linear-server__save_comment
---

# Identify a Scratch backlog issue ready for an agent

Picks **one** eligible Backlog issue from the **Scratch** Linear project and reviews whether it's
implementable without a developer. When the top candidate isn't ready, it tags **Needs scoping**, leaves
an explanatory comment, and **advances to the next candidate** until it finds a ready one. Its only
output is the ready **`DEV-####`** to hand to the `/dev-issue` skill — it does **not** claim, branch, or
implement.

> **Read-only except the Needs-scoping tag.** The only writes this skill makes are adding the
> `Needs scoping` label and a scoping comment to tickets that aren't ready. It never assigns an issue,
> changes its status, creates a branch, or opens an MR. Those belong to `/dev-issue`.

> **Runs one selection per invocation.** It reports a single ready issue (or "none ready this run").

## Pipeline at a glance

0. **Preflight** — verify Linear is usable and resolve the runner identity (for attributed comments).
1. **Select** — the top eligible issue (highest priority, tie-break oldest).
2. **Evaluate readiness (tag + advance)** — enough info to implement without a developer? If not →
   `Needs scoping` + comment, then move to the next candidate. If yes → report it and stop.

The next step is a human: run `/dev-issue DEV-####` with the reported id to claim and implement it.

## Fixed values for this workspace

Stable ids — use directly; spot-check with a read-only call only if a write fails.

| Thing | Value |
| --- | --- |
| Team | `Dev` (id `b4e2b7f8-c4c2-4aaa-848c-e306f07c1a8f`) |
| Project | `Scratch` (id `41604a71-549f-4794-ab01-1b7f3b82d2dc`) |
| Status: Backlog | `81cb87fa-4a97-464c-afef-846b8c24c87f` (type `backlog`) |
| Status: In Progress | `4ded5245-8956-4d8d-99b4-2f7f60e5fca6` (type `started`) |
| Label: Agent | `9ebfb43f-7058-42fd-8edf-b6eeb405f1b7` |
| Label: Needs scoping | `e2322ed9-6b2c-4d1e-80ce-113691749cb5` |

> ⚠️ There are decoy projects **`Scratch (Old)`** (`28999d63-a6a4-41ab-9ce9-ba55027f5aae`) and
> **`Scratch User Tracker`** (`6e98ff91-64a5-4701-b354-fe2dfba9bfcc`). Always target the exact project
> id `41604a71-549f-4794-ab01-1b7f3b82d2dc`, never a fuzzy name match.

**Sizes** are the numeric **`estimate`** field, not labels: **XS=1, S=2, M=3** (L=5, XL=8, 0/unset = no
size). Eligible sizes for this skill are **XS, S, M** only — reject L, XL, and unsized issues.

**Priority** is `priority.value`: `0`=None, `1`=Urgent, `2`=High, `3`=Medium, `4`=Low. "Highest
priority first" orders **Urgent → High → Medium → Low → None** (note `None`/`0` sorts **last**, not
first).

## Linear MCP tool names

Depending on how the Linear MCP is registered, its tools are exposed as either `mcp__linear__*`
(e.g. `mcp__linear__list_issues`) or `mcp__linear-server__*`. Use whichever prefix is present in this
session; the names after the prefix are identical. Everywhere below, `<linear>` means that prefix.

## Auto-mode contract (read first)

This skill is meant to run with **no human at the keyboard**. Hold to these rules:

- **Never call `AskUserQuestion`.** Readiness is judged by a sub-agent (Step 2); the choice is made, not
  deferred.
- **Idempotent / read-mostly.** Re-running just re-selects and re-reviews; the only side effect is the
  `Needs scoping` label + comment, which are additive and reversible.
- **`allowed-tools` must cover every action** so a scheduled run never stalls on a permission prompt.

## Step 0 — Preflight

Verify Linear with a cheap read-only check. If it fails, stop immediately and report what's missing.

1. **Linear** — `<linear>_list_teams({ "query": "Dev" })`. No `mcp__linear__*` / `mcp__linear-server__*`
   tools at all → Linear MCP not configured, stop. Auth error (401/403, token expired) → tell the user
   to re-authenticate the Linear MCP, stop.
2. **Runner identity** — `<linear>_get_user({ "query": "me" })` → keep `name` as **RUNNER_NAME** for
   attributed Needs-scoping comments.

## Step 1 — Select the issue (highest priority, tie-break oldest)

If a `DEV-####` argument was given, load that issue with `<linear>_get_issue({ "id": "DEV-####" })` and
**validate** it against every eligibility rule below; if it doesn't qualify, report why and stop. Otherwise
auto-select:

```
<linear>_list_issues({ "project": "41604a71-549f-4794-ab01-1b7f3b82d2dc",
  "state": "Backlog", "assignee": "null", "label": "Agent", "limit": 250, "orderBy": "createdAt",
  "fields": ["title","description","estimate","labels","status","gitBranchName","priority","createdAt","url"] })
```

- `assignee: "null"` returns only **unassigned** issues; `label: "Agent"` filters to the `Agent` label
  server-side. Page via the returned `cursor` while `hasNextPage`.
- **Client-side filter** the results:
  - drop any issue whose `labels` include **`Needs scoping`** (the server call can only filter one label);
  - keep only issues with `estimate.name ∈ {XS, S, M}` (reject unsized and L/XL).
- **Sort** the survivors by priority rank (Urgent → High → Medium → Low → None), tie-break by earliest
  `createdAt`. This ordered list is your candidate queue for Step 2. Record each survivor's `id`
  (DEV-####), `url`, `gitBranchName`, `priority`, and `estimate`.
- If nothing is eligible, exit cleanly with a one-line "no eligible issues this run" note (no writes).

## Step 2 — Evaluate readiness: implementable without a developer? (tag + advance)

Walk the candidate queue from Step 1 in order. For the **current** candidate, load full context:
`<linear>_get_issue({ "id": "DEV-####" })` plus `<linear>_list_comments({ "issueId": "DEV-####" })`.
Spawn a **scoping-assessment sub-agent** (`Task`) that reads the issue and does light codebase
exploration, and returns a structured verdict:

```
{ "sufficient": true|false, "missing": ["…"], "affected_area": "server|client|desktop|scratch-git|…", "notes": "…" }
```

Judge **sufficient** = there is a clear problem/goal, the relevant code is locatable, and acceptance is
inferable **without a human decision** (no ambiguous product/UX call, no "which approach do we want?",
no missing repro for a non-obvious bug).

- **If sufficient (ready)** → **stop and report** this issue in the machine-readable form defined by the
  [Output contract](#output-when-a-ready-issue-is-found) below, so an external agent or routine can
  extract the id and hand it straight to `/dev-issue`. **Make no writes** to this issue — do not claim,
  assign, or change status.
- **If not sufficient** → do **not** claim. Flag it for a human and advance:
  1. Add `Needs scoping` (`e2322ed9-6b2c-4d1e-80ce-113691749cb5`) — `labels[]` on `save_issue` is a
     **full replacement**, so pass the **union** of the issue's existing label ids + the new one:
     ```
     <linear>_save_issue({ "id": "DEV-####", "labels": ["<existing id>", …, "e2322ed9-6b2c-4d1e-80ce-113691749cb5"] })
     ```
  2. Post `SCOPING_COMMENT` (below) listing what's missing.
  3. **Advance to the next candidate** in the queue and repeat Step 2. (The just-tagged issue now
     carries `Needs scoping`, so it won't be re-selected on a future run.)

If the queue is exhausted with no ready issue, exit with the **no-issue** output form defined below,
noting how many were tagged `Needs scoping` this run.

## Output contract

The **entire point** of this skill is to emit a ready issue id that another agent or routine can pass to
`/dev-issue` without a human in the loop. Make the id unambiguous and easy to parse — do not bury it in
prose only.

### Output when a ready issue is found

End your final message with a fenced block on its own, in exactly this shape (one field per line, the id
in canonical `DEV-####` form):

```
READY_ISSUE: DEV-####
URL: <issue url>
BRANCH: <gitBranchName>
TITLE: <issue title>
PRIORITY: <Urgent|High|Medium|Low|None>
SIZE: <XS|S|M>
```

Above the block, a one-line human summary and the readiness rationale are fine. Also state the literal
next command: **`/dev-issue DEV-####`**. A calling routine should read the `READY_ISSUE:` line to get the
id — it is the contract; everything else is context.

### Output when no ready issue is found

If nothing eligible was found, or the queue was exhausted with every candidate tagged `Needs scoping`,
end with:

```
READY_ISSUE: none
TAGGED_NEEDS_SCOPING: <count this run>
```

so a caller can reliably tell "nothing to do" from a real pick and skip invoking `/dev-issue`.

## Comment & message templates

**SCOPING_COMMENT** (insufficient to implement — Step 2)
```
🤖 Reviewed by an agent session (identify-agent-issue skill) on behalf of RUNNER_NAME and tagged
**Needs scoping** — there isn't enough here to implement autonomously without a developer's input.
Missing: <bulleted list of what's unclear — repro / expected behaviour / acceptance criteria / affected
area / product decision>. Once that's added, remove the label and it can be picked up on a future run.
```

## Guardrails

- **Selection only — never claims.** This skill never assigns an issue, changes its status, creates a
  branch, or opens an MR. It reports the ready `DEV-####`; `/dev-issue` does the rest.
- **No `AskUserQuestion`** — readiness is judged by a sub-agent, not deferred to a human.
- **Labels are a full replacement** — always pass the **union** of existing + new label ids to
  `save_issue`, or you'll silently drop labels.
- **Target the exact project id** `41604a71-549f-4794-ab01-1b7f3b82d2dc` — never a fuzzy name match
  (decoy projects exist).
- **Every Linear comment is attributed** — names RUNNER_NAME and states it came from the
  identify-agent-issue skill.
- **Eligibility is fixed** — Agent label, unassigned, not `Needs scoping`, size XS/S/M; highest priority
  first, tie-break oldest.
