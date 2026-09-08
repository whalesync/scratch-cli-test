---
name: dev-issue
description: Implement one Scratch Linear issue end-to-end given its DEV-#### — claim it, plan and implement the fix on its own branch, self-review with the code-review skill, open a draft GitLab MR, and ask a human to review in Slack. Requires the issue id as an argument (use /identify-agent-issue first to pick a ready one). Built to run unattended on a schedule/routine in auto-mode; a human is still the final gate (the MR is a draft and nothing merges automatically). Use when the user wants an agent to implement a specific Scratch backlog ticket end-to-end.
user-invocable: true
argument-hint: "DEV-#### (required)"
allowed-tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Write
  - Task
  - Skill
  - Bash(git:*)
  - Bash(glab mr:*)
  - Bash(glab auth status:*)
  - Bash(yarn:*)
  - Bash(cargo:*)
  - Bash(node:*)
  - mcp__linear__list_teams
  - mcp__linear__list_issues
  - mcp__linear__get_issue
  - mcp__linear__list_comments
  - mcp__linear__list_issue_labels
  - mcp__linear__list_issue_statuses
  - mcp__linear__get_user
  - mcp__linear__save_issue
  - mcp__linear__save_comment
  - mcp__linear__create_attachment
  - mcp__linear-server__list_teams
  - mcp__linear-server__list_issues
  - mcp__linear-server__get_issue
  - mcp__linear-server__list_comments
  - mcp__linear-server__list_issue_labels
  - mcp__linear-server__list_issue_statuses
  - mcp__linear-server__get_user
  - mcp__linear-server__save_issue
  - mcp__linear-server__save_comment
  - mcp__linear-server__create_attachment
  - mcp__claude_ai_Slack__slack_search_channels
  - mcp__claude_ai_Slack__slack_send_message
---

# Implement a Scratch backlog issue end-to-end

Given a **`DEV-####`** issue in the **Scratch** Linear project, this skill claims it, implements the fix
on its own branch, self-reviews with the `code-review` skill, opens a **draft** GitLab MR, and pings a
human to review in Slack. Designed to run **unattended in auto-mode** (e.g. an after-hours `/schedule`
routine — see [Run it as a routine](#run-it-as-a-routine)).

> **Requires an issue id.** This skill does **not** select an issue — pass the `DEV-####` explicitly.
> Use `/identify-agent-issue` first to pick a ready, well-scoped ticket, then run `/dev-issue DEV-####`.

> **A human is always the final gate.** Nothing merges automatically. This skill only ever produces a
> **draft** MR and asks a person to review it; a developer still reviews, un-drafts, and merges. Its
> Linear writes (claim, status, `Needs scoping`, comments) are reversible.

> **Runs one issue per invocation.** Throughput is controlled by how often the routine fires, not by
> looping over many issues in a single run.

## Pipeline at a glance

0. **Preflight** — verify Linear, `glab`, git, Node/yarn, and Slack are all usable; hard-stop with a
   checklist if any is missing (never claim an issue then die mid-run).
1. **Load & verify** — load the given `DEV-####`; confirm it exists and is still claimable (race guard).
2. **Claim** — assign to the runner, set **In Progress**, comment.
3. **Plan** — a sub-agent designs the implementation; a reviewer sub-agent refines it and resolves any
   open choices (defaulting to the recommended option — no human prompt).
4. **Branch + baseline** — a working tree on the Linear-suggested branch; capture a build/lint/test
   baseline so pre-existing failures don't get blamed on this change.
5. **Implement** — normal development, repo conventions.
6. **Self-review loop** — `code-review` at level **high** in a sub-agent, fix real findings, retest;
   up to 3 rounds.
7. **Commit → MR → draft** — commit, `create-mr`, then mark the MR draft; link it on the issue.
8. **Notify** — post to `#agent-mr-needs-code-review` with the MR + Linear links.

If the skill can't finish after claiming, it follows the [Blocked path](#blocked-path--return-to-backlog):
return the issue to Backlog with `Needs scoping` and an explanatory comment.

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
size). Selection/eligibility is `/identify-agent-issue`'s job — this skill implements whatever id it's
given.

**Priority** is `priority.value`: `0`=None, `1`=Urgent, `2`=High, `3`=Medium, `4`=Low.

## Linear MCP tool names

Depending on how the Linear MCP is registered, its tools are exposed as either `mcp__linear__*`
(e.g. `mcp__linear__get_issue`) or `mcp__linear-server__*`. Use whichever prefix is present in this
session; the names after the prefix are identical. Everywhere below, `<linear>` means that prefix.

## Slack MCP tool names

The Slack MCP tools are `<slack>_search_channels` and `<slack>_send_message`, where `<slack>` is
whatever Slack prefix is present this session (here `mcp__claude_ai_Slack__`; in a cloud routine the
connector may register a different prefix). Never hardcode a channel id — resolve it at runtime
(Step 0 / Step 8).

## Auto-mode contract (read first)

This skill is meant to run with **no human at the keyboard**. Hold to these rules:

- **Never call `AskUserQuestion`.** Where a real development session would ask the user, spawn a
  sub-agent to make the call and **fall back to the recommended option**. Decisions are made, not
  deferred.
- **Preflight everything up front (Step 0) and hard-stop with an explicit checklist** if a prerequisite
  is missing, rather than discovering it mid-run. Do not claim an issue you can't finish onboarding.
- **Distinguish pre-existing failures from regressions.** Capture a build/lint/test baseline on the
  fresh branch (Step 4). The repo's "don't ignore pre-existing test/lint errors — stop and ask" rule
  (`CLAUDE.md`) has no human to ask here, so instead: a failure already present in the baseline is
  **noted** (surfaced in the MR + Slack) but does **not** block; only a **new** failure introduced by
  this change blocks and, if unfixable in the review loop, triggers the [Blocked path](#blocked-path--return-to-backlog).
- **Idempotent / safe to re-run.** Re-verify the issue is still claimable immediately before claiming
  (Step 2). One issue per run.
- **`allowed-tools` must cover every action** so a scheduled run never stalls on a permission prompt.

## Step 0 — Preflight

Verify each capability with a cheap read-only check. If **any** fails, stop immediately and report the
full checklist of what's missing — **claim nothing**.

1. **Linear** — `<linear>_list_teams({ "query": "Dev" })`. No `mcp__linear__*` / `mcp__linear-server__*`
   tools at all → Linear MCP not configured, stop. Auth error (401/403, token expired) → tell the user
   to re-authenticate the Linear MCP, stop.
2. **Runner identity** — `<linear>_get_user({ "query": "me" })` → keep `name` as **RUNNER_NAME** and the
   user id for `assignee`. `assignee: "me"` resolves to this same authenticated user when writing.
3. **glab** — `glab auth status`. If it reports `401 Unauthorized` / `No token found` / otherwise
   unauthenticated, stop and tell the user to run `glab auth login` (the `create-mr` step would
   otherwise fail with a misleading 404).
4. **git** — confirm you're inside the spinner repo with a clean working tree and can reach
   `origin/master` (`git fetch origin master`). A dirty tree → stop (don't mix unrelated changes in).
5. **Node/yarn** — the repo needs Node 22; `source ~/.nvm/nvm.sh && nvm use` (from `.nvmrc`). Never pipe
   `nvm use` into another command (the PATH change is lost).
6. **Slack** — resolve the target channel now so a late failure can't strand a finished MR:
   `<slack>_search_channels({ "query": "agent-mr-needs-code-review", "channel_types": "public_channel,private_channel" })`.
   Keep the channel id. If Slack isn't available or the channel can't be found, stop.

## Step 1 — Load and verify the issue

This skill implements a **specific** issue — it does not select one.

- **Require the id.** If no `DEV-####` argument was given, stop and tell the user to pass one (run
  `/identify-agent-issue` first to pick a ready ticket). In auto-mode this is a hard stop — there is no
  unit of work without an id.
- **Load it:** `<linear>_get_issue({ "id": "DEV-####" })` plus
  `<linear>_list_comments({ "issueId": "DEV-####" })`. Confirm it exists and belongs to the Scratch
  project (`41604a71-549f-4794-ab01-1b7f3b82d2dc`); if not, report and stop. Record its `title`, `url`,
  and `gitBranchName`.
- **Trust the readiness review.** `/identify-agent-issue` is responsible for judging whether the issue
  is implementable without a developer — do **not** re-run the scoping gate here. (If you were handed an
  id that turns out to be unimplementable, the [Blocked path](#blocked-path--return-to-backlog) is the
  escape hatch.)
- **Race guard.** Verify the issue is still claimable: **Backlog + unassigned**, or already assigned to
  the runner from a prior partial run (idempotent re-run). If a human or another run has taken it
  (assigned to someone else, or already In Progress under a different owner), stop and report — don't
  steal an in-flight ticket.

## Step 2 — Claim the issue

```
<linear>_save_issue({ "id": "DEV-####", "assignee": "me", "state": "In Progress" })
<linear>_save_comment({ "issueId": "DEV-####", "body": "<CLAIM_COMMENT>" })
```

## Step 3 — Create and refine the implementation plan

This replaces the human back-and-forth of a normal planning session:

1. Spawn a **Plan sub-agent** (`Task`) with the full issue context; ask for a concrete, step-by-step
   implementation plan (files to change, approach, tests, risks) that reuses existing utilities and
   follows repo conventions.
2. Spawn a **reviewer sub-agent** to critique and refine that plan and to **resolve every open decision
   point** — where the plan says "option A vs B" or "recommend X", pick the **recommended** option.
   Never surface the choice to a human.
3. Adopt the refined plan and proceed. Keep it in working memory (and optionally note the chosen
   approach in the eventual MR description).

## Step 4 — Working tree, branch, and baseline

- **Branch name = the issue's `gitBranchName` verbatim** (e.g.
  `dev-11423-remove-temporarysyncwithpull-job`). Create an isolated working tree from master:
  ```
  git fetch origin master
  git worktree add ../wt-<gitBranchName> -b <gitBranchName> origin/master
  ```
  (In a dedicated single-purpose clone — the cloud-routine case — a plain
  `git checkout -b <gitBranchName> origin/master` is equivalent.)
- **Bootstrap the tree** (a fresh worktree/clone has no `node_modules`), mirroring `conductor.json`
  setup: `nvm use` → copy the needed `.env` files if absent → `yarn install` →
  `cd server && yarn prisma generate` → `cd packages/shared-types && yarn build`. Do **not** symlink the
  main checkout's `node_modules` (causes bogus dual-identity `tsc` errors).
- **Capture a BASELINE** on the untouched branch: run `yarn build` and `yarn lint` from the repo root,
  plus the test suite(s) covering the area you'll touch, and record any failures. These are
  **pre-existing** and must not be blamed on this change (test flakiness is a known thing — see the
  scheduled-failure catalog). Only **new** failures introduced by your change count as regressions.

## Step 5 — Implement

Do the work like a normal development session, honoring repo conventions:

- **Always `yarn`, never `npm`.** Run build/lint/test from the **repo root** via Turborepo.
- Server: `WSLogger.info|warn|error` (never `console.log`), Prisma/Knex as established, no `as any`.
  Client: `console.debug`, Mantine + App Router, Zustand/SWR. Obey every subdirectory `CLAUDE.md`.
- Prefer **maximum self-documenting names**. Reuse existing functions/utilities over new code.
- Add or adjust tests where the change warrants it.
- Keep the change **scoped to the issue** — no drive-by refactors.
- Format before finishing: `yarn prettier:check` / `--write` in the affected package.

## Step 6 — Self-review loop (`code-review` at level **high**, up to 3 rounds)

Repeat up to **3 times**, or until a round finds no fixable problems:

1. Spawn a **review sub-agent** (`Task`) that runs `/code-review high` against the current change (the
   uncommitted working-tree diff; if you've already committed, target the branch so it diffs against
   `origin/master`) and returns its consolidated findings — each with file/line, category, and verdict
   (`CONFIRMED` | `PLAUSIBLE`). (At `high` the skill fans out to parallel reviewers internally; the
   sub-agent is a thin wrapper that reports the result back.)
2. **Triage in the main agent** (you hold the implementation context):
   - **Fix** `CONFIRMED` correctness / robustness / security / api-contract findings.
   - **Skip** nitpicks, style, and minor findings that need human judgment — record them to mention in
     the MR + Slack. Don't make speculative changes to satisfy a `PLAUSIBLE` nit.
3. If you made fixes, **retest**: re-run `yarn build` / `yarn lint` and the relevant tests, comparing
   against the Step 4 baseline (only new failures matter).
4. Exit the loop when a round yields nothing worth fixing, or after the 3rd round.

If, after 3 rounds, a **real blocker** remains (a `CONFIRMED` correctness issue you couldn't fix, or a
new regression that won't clear), go to the [Blocked path](#blocked-path--return-to-backlog).

## Step 7 — Commit, open the MR, mark it draft

1. **Commit** to the branch. (This skill is the deliberate exception to the usual "the user handles
   their own commits" rule — committing is the whole point of the automation, authorized by invoking
   this skill.) Message: `[tag] Short summary (DEV-####)` using `create-mr`'s tag convention
   (`[server]` / `[client]` / `[desktop]` / `[scratch-git]` / `[terraform]` / `[docs]` / `[ci]`, one
   optional secondary tag like `[server, tests]`). End the message with the required trailer:
   ```
   Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
   ```
2. **Open the MR** with the `create-mr` skill (invoke `Skill(create-mr)`, base `master`). It rebases
   onto master, **pushes the feature branch** (never `master` — pushing to a protected branch is
   forbidden; the MR merely *targets* master), generates the title/description (it will pick up the
   `DEV-####` from the branch name), and creates the MR. Capture the MR **number** and **URL** it reports.
3. **Mark it a draft** — `create-mr` does not create drafts, so convert it immediately:
   ```
   glab mr update <mr-number> --draft
   glab mr view <mr-number>          # confirm it now shows "Draft"
   ```
4. **Link the MR back on the issue** so the two are connected — either
   `<linear>_create_attachment` with the MR URL, or a short comment containing the MR link.

## Step 8 — Notify developers in Slack

Send a real message (not a draft — this is unattended) to `#agent-mr-needs-code-review`, using the
channel id resolved in Step 0 (re-resolve if needed):

```
<slack>_send_message({ "channel_id": "<resolved id>", "message": "<SLACK_MESSAGE>" })
```

`SLACK_MESSAGE` must include a one-line summary, the **draft MR link**, the **Linear issue link**, and a
note of anything a reviewer should know (skipped nitpicks, pre-existing baseline failures) — see the
template below.

Then report a concise final summary (issue, branch, MR URL, review rounds, anything skipped).

## Blocked path — return to Backlog

If the skill **can't finish after claiming** (implementation stalls, a new build/lint/test regression
won't clear, or a real blocker survives 3 review rounds), unwind cleanly:

1. **Abandon the branch** — do **not** open an MR. Remove the worktree
   (`git worktree remove ../wt-<gitBranchName> --force`); if a branch was already pushed, that's fine to
   leave, but no MR is created.
2. **Comment** `BLOCKED_COMMENT` on the issue describing what was attempted and the blocker.
3. **Add `Needs scoping`** via the union-of-existing-labels `save_issue` call (`labels[]` is a full
   replacement, so pass the union of existing label ids + `e2322ed9-6b2c-4d1e-80ce-113691749cb5`).
4. **Return it to the pool** — set status back to Backlog and unassign:
   ```
   <linear>_save_issue({ "id": "DEV-####", "state": "Backlog", "assignee": null })
   ```
5. **Stay quiet on Slack** — the Slack channel is only for review-ready MRs. The `Needs scoping` label
   plus the comment is the human signal for a blocked ticket.

## Comment & message templates

**CLAIM_COMMENT**
```
🤖 Claimed by an agent session (dev-issue skill) on behalf of RUNNER_NAME. I'm starting automated
implementation now and will open a **draft** MR and request a human review when it's ready.
(Automated backlog development.)
```

**BLOCKED_COMMENT** (claimed but couldn't finish — Blocked path)
```
🤖 Attempted by an agent session (dev-issue skill) on behalf of RUNNER_NAME, but I couldn't complete it
autonomously, so I've returned it to **Backlog** and tagged **Needs scoping**. What I tried: <short
summary of the approach>. Blocker: <what stopped me>. No MR was opened — a developer should take a look,
or refine the scope for a future automated run.
```

**SLACK_MESSAGE** (Step 8 — markdown)
```
🤖 *Agent MR needs review* — <one-line summary of the change>
• *MR (draft):* <mr_url>
• *Linear:* <issue_url> (DEV-####)
• *Notes:* <skipped nitpicks / pre-existing baseline failures, or "none">
Please review before this is marked ready to merge. Opened by the dev-issue skill on behalf of
RUNNER_NAME.
```

## Run it as a routine

To do automated after-hours development, wire this skill into a scheduled cloud agent alongside
`/identify-agent-issue`:

- Use **`/schedule`** to create a routine whose **prompt** first runs `/identify-agent-issue` to pick a
  ready issue, reads the `READY_ISSUE: DEV-####` line from that skill's output contract, and — only if
  it is a real id (not `READY_ISSUE: none`) — runs `/dev-issue DEV-####` on it. The two skills are
  independent and never invoke each other, so the routine prompt does the orchestration. A good cadence
  is a weekday
  after-hours cron, e.g. `0 22 * * 1-5` (10pm, Mon–Fri). Each firing works one issue; set the cadence to
  the throughput you want. (`/loop` only babysits a live local session — `/schedule` is the unattended,
  laptop-closed mechanism.)
- `/schedule` requires a **claude.ai login** (API-key auth isn't supported) and provisions a cloud git
  environment — tell it to **clone the spinner repo**.
- The **Linear and Slack connectors must be connected** in claude.ai
  (https://claude.ai/customize/connectors) so the routine has those MCP tools; an interactively-
  authenticated MCP can't complete OAuth mid-run in a headless environment.
- Run it under **auto-mode** (or with an allowlist covering both skills' `allowed-tools`) so it never
  stalls on a permission prompt. Do **not** rely on `--dangerously-skip-permissions` (it needs a
  one-time interactive accept). `glab` must be authenticated in the environment.

## Guardrails

- **Requires a `DEV-####`.** This skill never auto-selects — it implements the id it's given. Use
  `/identify-agent-issue` to pick one.
- **Human stays the final gate.** Only ever produce a **draft** MR and ask for review; never mark ready,
  approve, or merge, and never push to a protected branch (`master`).
- **No `AskUserQuestion`** — resolve every choice with a sub-agent, defaulting to the recommended option.
- **Preflight or bail.** If a prerequisite is missing (Step 0), stop before claiming — don't half-do it.
- **Labels are a full replacement** — always pass the **union** of existing + new label ids to
  `save_issue`, or you'll silently drop labels.
- **Re-verify before claiming** (still claimable — Backlog + unassigned, or already yours); one issue
  per run; safe to re-run.
- **Pre-existing ≠ regression** — baseline first; only new failures block.
- **Stay in scope** — implement the issue, no drive-by refactors.
- **Every Linear comment is attributed** — names RUNNER_NAME and states it came from the dev-issue skill.
- **Blocked → Backlog**, not a broken MR: unwind, comment, `Needs scoping`, unassign.
