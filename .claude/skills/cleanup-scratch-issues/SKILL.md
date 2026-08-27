---
name: cleanup-scratch-issues
description: Groom the Backlog + To-Do issues in the Scratch Linear project for hygiene — flags issues with no label (inferring labels from the title/description) plus Connector bug / Feature issues that are missing their connector label, weak or empty descriptions, small XS/S tasks that are good agent candidates, and issues assigned but with no comment activity in over two weeks; then reports everything and, behind four separate confirmation gates, adds inferred/connector labels, the Agent label, the Needs scoping label, and attributed check-in comments. Purely additive — never edits descriptions, removes labels, changes status, or deletes. Use when the user wants to clean up / groom / tidy / review the Scratch Linear issues for missing labels, weak descriptions, agent candidates, or stale assignments.
user-invocable: true
allowed-tools:
  - mcp__linear__list_teams
  - mcp__linear__list_issues
  - mcp__linear__get_issue
  - mcp__linear__list_issue_labels
  - mcp__linear__list_comments
  - mcp__linear__get_user
  - mcp__linear__save_issue
  - mcp__linear__save_comment
  - mcp__linear__create_issue_label
  - mcp__linear-server__list_teams
  - mcp__linear-server__list_issues
  - mcp__linear-server__get_issue
  - mcp__linear-server__list_issue_labels
  - mcp__linear-server__list_comments
  - mcp__linear-server__get_user
  - mcp__linear-server__save_issue
  - mcp__linear-server__save_comment
  - mcp__linear-server__create_issue_label
  - AskUserQuestion
---

# Clean up the Scratch Linear issues

Loads the **Backlog + To-Do** issues in the **Scratch** project (both assigned and unassigned),
evaluates each against four hygiene criteria, reports everything in one scannable pass, and — behind
four independent confirmation gates — applies additive fixes. Follow the steps in order.

> This skill only ever **adds** things: labels on issues, the `Agent` / `Needs scoping` labels, an
> optional new connector label, and check-in comments. It **never** edits descriptions, removes a
> label, changes an issue's status, or deletes anything. Every change is reversible.

## The four criteria

- **A — Missing a label (two passes, over ALL loaded issues).**
  - **A1 · Label-less issues.** Every issue should carry at least one label. For a label-less issue,
    infer labels from its title + description; if it's *mainly about a single connector*, include that
    connector's label.
  - **A2 · Connector-label enrichment.** For issues that *already* have labels, add a connector label
    **only if** the issue already carries the **`Connector bug`** or **`Feature`** label **and** it is
    mainly about a single connector that is missing its label. Do **not** add connector labels to
    issues whose labels are anything else (e.g. `Infra`, `Compliance`, `CI`, `Testing`) — that avoids
    over-tagging tangential mentions.
  - In either pass, if the connector it centers on has **no** label in the workspace yet, record a
    *missing-connector-label gap* and notify the user (Gate 1 offers to create it).
- **B — Weak description.** Issues should clearly describe the bug, feature, or task. Flag ones that
  don't give enough to act on. An issue that links a shaping/design doc gets a pass **only if** it
  also has a ≥2–3 sentence overview that mentions the details are in the linked doc.
- **C — Agent candidate.** An **XS or S** task with a clear problem statement and a focused set of
  objectives is a candidate for an agent to investigate/implement asynchronously → the `Agent` label.
- **D — Stale assignment.** An issue that is **assigned** but has had **no real activity in over two
  weeks** gets a check-in comment asking the assignee whether it's still active. Staleness is judged
  from **comment activity + the issue's `createdAt`**, NOT `updatedAt` — bulk field edits (imports,
  triage sweeps) inflate `updatedAt` and would hide genuinely stale issues.

## Fixed values for this workspace

Stable ids — use directly; spot-check with a read-only call only if a write fails.

| Thing | Value |
| --- | --- |
| Team | `Dev` (id `b4e2b7f8-c4c2-4aaa-848c-e306f07c1a8f`) |
| Project | `Scratch` (id `41604a71-549f-4794-ab01-1b7f3b82d2dc`) |
| Status: Backlog | `81cb87fa-4a97-464c-afef-846b8c24c87f` (type `backlog`) |
| Status: To Do | `090a2059-cd19-4476-97c5-1174050a8017` (type `unstarted`) |
| Label: Agent | `9ebfb43f-7058-42fd-8edf-b6eeb405f1b7` ("picked up automatically by agents") |
| Label: Needs scoping | `e2322ed9-6b2c-4d1e-80ce-113691749cb5` |

> ⚠️ There are decoy projects **`Scratch (Old)`** (`28999d63-a6a4-41ab-9ce9-ba55027f5aae`) and
> **`Scratch User Tracker`** (`6e98ff91-64a5-4701-b354-fe2dfba9bfcc`). Always target the exact project
> id `41604a71-549f-4794-ab01-1b7f3b82d2dc`, never a fuzzy name match.

> **Scope is the two named statuses `Backlog` and `To Do` only** — not the whole `backlog` *type*
> (which would also sweep in `Product design` and `Waiting for User`). Query each named status
> explicitly.

### Connector label reference (children of the `Connector` group)

Fallback reference only — **always trust the live set loaded in Step 0 over this table**, since labels
change. Sizes/connectors evolve.

| Connector | Label id |
| --- | --- |
| Airtable | `715b2dfc-bef7-4efd-bad6-1614b99e5010` |
| Notion | `3cd4a5f0-9b0b-4ef9-bdd3-df5545bd8c6f` |
| Webflow | `af25ef06-f82d-469b-848c-6c5c0b38102d` |
| WordPress | `bf816514-5e9d-46ab-bda4-e91517e3b539` |
| Shopify | `63b3cb7c-cdc9-4713-885b-2116ca2dce52` |
| HubSpot | `3097393b-4947-4e24-b6eb-94a5a4a5f6c9` |
| Salesforce | `7f762336-c5f0-45a0-8bd2-e697471182e7` |
| Stripe | `8ee25dc1-a499-43d9-8eed-22e3986832fb` |
| Pipedrive | `3a1725db-bd89-4a8f-b0b6-04cf3095dca0` |
| Intercom | `65e496e1-98a8-4fff-92e0-7e878ce0e858` |
| Affinity | `0c757c1a-8d14-459e-904d-c10a85dc11ea` |
| Attio | `9240ff8f-32a6-4724-8cc2-e0ec6e0944cc` |
| Supabase | `b7cb3168-73d6-4b4c-b5fb-621959243c2d` |
| Postgres | `23eb9fef-a72b-4530-af31-73c0a792eb80` |
| Google Sheets | `4e977117-71b0-4d97-9b9f-ded0ccdc6e57` |
| YouTube | `699f9e3f-6a73-4569-9cf8-713986755ac7` |
| CSV | `3939daa9-4d5f-46e5-8ca4-37dac3fb8dcb` |
| Wix CMS | `6a06e110-5b16-49d2-a1cb-91be1f42bc98` |
| Wix Blog | `00629628-5982-4233-9b8a-e529b6c24550` |
| New Connector | `71890767-eb9b-451f-a240-d0f3cb09ee47` |
| Connector Infra | `6a4e1cc2-cc51-4181-8b9b-5bdbc01d2782` |

## Sizes (the `estimate` field)

Sizes are the numeric **`estimate`** field, not labels. T-shirt mapping: **XS=1, S=2, M=3, L=5, XL=8**
(0 / unset = no size). Agent candidates (criterion C) are XS (`1`) or S (`2`) only.

## Linear MCP tool names

Depending on how the Linear MCP is registered, its tools are exposed as either `mcp__linear__*`
(e.g. `mcp__linear__list_issues`) or `mcp__linear-server__*`. Use whichever prefix is present in this
session; the names after the prefix are identical. Everywhere below, `<linear>` means that prefix.

## Step 0 — Preflight: connectivity, runner, and the live label set

1. Confirm the Linear MCP works with one cheap read-only call: `<linear>_list_teams({ "query": "Dev" })`.
   - If no `mcp__linear__*` / `mcp__linear-server__*` tools exist at all → tell the user the Linear
     MCP isn't configured for this session and stop.
   - If it errors with auth/permission (401/403, "unauthorized", token expired) → tell the user to
     re-authenticate the Linear MCP and stop.
2. Resolve **who is running the skill** (needed for check-in comments):
   `<linear>_get_user({ "query": "me" })` → keep the returned `name` as **RUNNER_NAME**. If it can't
   be resolved, ask the user for the name to attribute the run to before posting any comment.
3. Load the full label universe once: `<linear>_list_issue_labels({ "team": "Dev", "limit": 250 })`
   (page via `cursor` if `hasNextPage`). From it build:
   - a **name → id** map of every existing issue label (case-insensitive lookup);
   - the set of existing **connector** labels — the children of the `Connector` parent group (each
     connector label carries `parent: "Connector"`, i.e. the group **name**);
   - to create a new connector label in Gate 1, pass `parent: "Connector"` (the group name — the API
     does not expose a separate group id here).
   Never apply or reference a label that isn't in this live set (the reference table above is only a
   fallback if the load fails).
4. Compute the **staleness cutoff** = 14 days before today's date (today's date is provided in the
   session context — do not call any clock/date tool). Any issue whose `updatedAt` is strictly before
   the cutoff is "stale" for criterion D.

## Step 1 — Load the issues (Backlog + To Do, all assignees)

Make two calls (one per status), covering **all** assignees (do not filter to unassigned — assigned
issues are needed for criterion D):

```
<linear>_list_issues({ "project": "41604a71-549f-4794-ab01-1b7f3b82d2dc",
  "state": "Backlog", "limit": 250,
  "fields": ["title","description","priority","estimate","labels","status","assignee","createdAt","updatedAt","url"] })

<linear>_list_issues({ "project": "41604a71-549f-4794-ab01-1b7f3b82d2dc",
  "state": "To Do", "limit": 250,
  "fields": ["title","description","priority","estimate","labels","status","assignee","createdAt","updatedAt","url"] })
```

- If either response has `hasNextPage: true`, page with the returned `cursor` until exhausted.
- If `description`, `createdAt`, or `updatedAt` come back empty/absent from `list_issues`, fetch the
  missing pieces per issue with `<linear>_get_issue({ "id": "DEV-####" })` (issues can be fetched in
  parallel).
- Merge the two result sets — this is the review population. Report its total count.
- **For each _assigned_ issue only**, fetch its comments to get the real activity signal for
  criterion D: `<linear>_list_comments({ "issueId": "DEV-####" })` (parallel across assigned issues).
  Keep the newest comment `createdAt` per issue (or note "no comments"). Do this only for assigned
  issues — unassigned issues can't be stale-assigned, so don't spend calls on them.

## Step 2 — Evaluate each issue against the four criteria

For every loaded issue, judge from its title + description + labels + estimate + assignee +
`updatedAt`. One issue can hit several criteria.

- **A — Missing label.** Run **both** passes over the whole population; map **only** to labels that
  exist in the Step 0 live set (never invent a name).
  - **A1 · Label-less issues (zero labels).** Infer likely labels from the title + description. Guides:
    a bug → the matching `*bug` label; a connector name → that connector's label;
    security/compliance/infra wording → those labels; a clear feature ask → `Feature`. If the issue is
    mainly about one connector, include that connector's label. If you genuinely can't infer any
    existing label, say so and leave it for the user.
  - **A2 · Connector-label enrichment (labeled issues).** Consider an issue **only if** its current
    labels include **`Connector bug`** or **`Feature`**. If such an issue is mainly about a single
    connector and is missing that connector's label, propose adding it. Issues whose labels are
    anything else (`Infra`, `Compliance`, `CI`, `Testing`, `Other bug`, …) are **out of scope** for
    connector enrichment even if they mention a connector — do not propose a connector label for them.
  - In either pass, if the connector has **no** live label, don't fabricate one — record a
    **missing-connector-label gap** naming the connector (Gate 1 can create it).
- **B — Weak description.** Flag issues whose description is empty, a bare one-liner, or too vague to
  act on: a bug with no repro / expected-vs-actual, a feature with no what/why/scope, a task with no
  concrete objective. **Pass** an issue that links a shaping/design doc **and** carries a ≥2–3 sentence
  overview pointing at that doc; a doc link with no overview is still weak.
- **C — Agent candidate.** Qualifies only if **all** hold: estimate is **XS (1) or S (2)**; the issue
  has a clear problem statement and a focused, well-bounded set of objectives; it is **not** flagged
  weak under B; and it doesn't already carry the `Agent` label. A vague or broad ticket is never an
  agent candidate.
- **D — Stale assignment.** `assignee` is non-null **and** the issue's **last real activity** is
  strictly before the Step 0 cutoff (over two weeks old). Compute
  `last_activity = max(issue.createdAt, newest comment createdAt)` from the Step 1 comment fetch — an
  issue is stale when even its most recent comment (or, if it has none, its creation) predates the
  cutoff. **Ignore `updatedAt`** — bulk field edits inflate it and would falsely mark stale issues as
  fresh. Capture the assignee's name and the `last_activity` date (and whether it came from a comment
  or from creation-with-no-comments).

## Step 3 — Present the report

Produce a scannable Markdown report. **State plainly that nothing has been changed yet.**

1. **Summary** — population size, and counts for: label-less (A1), connector-enrichment (A2),
   weak-description (B), agent candidates (C), stale assigned (D), and missing-connector-label gaps.
2. **A1 · Label-less issues** — table (`Issue`, `Pri`, `Size`, short title, **Inferred labels**). Note
   any issue where no existing label could be inferred.
3. **A2 · Connector-label enrichment** — table (`Issue`, `Current labels`, **Connector to add**),
   listing only issues that carry `Connector bug` or `Feature` and are missing their connector label.
4. **Missing connector labels** — a callout listing each connector referenced by an issue that has no
   label in the workspace, with the issue(s) that need it.
5. **B · Weak descriptions** — table (`Issue`, `Pri`, `Size`, short title, one-line reason it's weak).
6. **C · Agent candidates** — table (`Issue`, `Pri`, `Size`, short title).
7. **D · Stale assignments** — table (`Issue`, `Assignee`, `Last activity` (date + comment/created),
   short title).

## Step 4 — Gate 1: apply labels (label-less fixes + connector enrichment + gaps)

Ask with a single `AskUserQuestion` that separates the two label passes plus the create-label offer:

- **"Apply inferred labels to the label-less issues (A1)?"** Options: `Apply all`, `Select which`,
  `Skip`.
- **"Add connector labels to the `Connector bug` / `Feature` issues that are missing them (A2)?"**
  Options: `Apply all`, `Select which`, `Skip`.
- If there are missing-connector-label gaps: **"Create the missing connector labels and apply them?"**
  Options: `Create & apply all`, `Select which`, `Don't create`.

For each confirmed issue:

1. `labels[]` on `save_issue` is a **full replacement** — read the issue's **current** labels (from
   Step 1) and pass the **union** of existing + new so nothing is dropped:
   ```
   <linear>_save_issue({ "id": "DEV-####", "labels": ["<existing label id/name>", ..., "<new label id/name>"] })
   ```
2. For each **missing-connector-label gap** the user approved creating (third question above), create
   the label under the `Connector` group, then apply it to the relevant issue(s) via the union pattern:
   ```
   <linear>_create_issue_label({ "team": "Dev", "name": "<Connector>", "parent": "Connector" })
   ```
   (Connector labels carry their group as `parent: "Connector"` — pass the group **name**, not an id.)
   If the user declines, leave the gap in the report and move on.

If the user skipped a pass, apply nothing for it and continue.

## Step 5 — Gate 2: the `Agent` label on agent candidates

Single `AskUserQuestion`:

- **"Tag the agent candidates with the `Agent` label?"** Options: `Tag all candidates`,
  `Select which to tag`, `Skip`.

For each confirmed candidate, add the `Agent` label (`9ebfb43f-7058-42fd-8edf-b6eeb405f1b7`) using the
same **union-of-existing-labels** `save_issue` call. Skip any that already carry it.

## Step 6 — Gate 3: `Needs scoping` on weak descriptions

Weak descriptions are only *identified* by this skill — the sole action offered is attaching the
`Needs scoping` label. Single `AskUserQuestion`:

- **"Attach the `Needs scoping` label to the weak-description issues?"** Options: `Attach to all`,
  `Select which`, `Skip`.

For each confirmed issue, add `Needs scoping` (`e2322ed9-6b2c-4d1e-80ce-113691749cb5`) via the
union-of-existing-labels `save_issue` call.

## Step 7 — Gate 4: check-in comments on stale assignments

List the stale assigned issues (from Step 2/D) and let the user **pick which get a comment** — never
auto-post to all. Single `AskUserQuestion`:

- **"Which stale assigned issues should get a check-in comment?"** Options: `Comment on all listed`,
  `Select which`, `Skip`.

For each chosen issue, in order:

1. **Re-verify scope** — the issue must still be in `Backlog` or `To Do` and still **assigned**. If it
   moved status or was unassigned since Step 1, **skip it** and note the skip. This keeps the skill
   safe to re-run.
2. **Post the comment** (the author is the authenticated Linear user automatically; the body also names
   the assignee and RUNNER_NAME and flags the agent):
   ```
   <linear>_save_comment({ "issueId": "DEV-####", "body": "<CHECK_IN_COMMENT>" })
   ```

Process independent issues in parallel; on a per-issue error, record it and continue — never abort the
whole batch for one failure.

### CHECK_IN_COMMENT format

Must (a) name the **assignee**, (b) name **RUNNER_NAME**, and (c) state it came from an agent. Use:

```
🤖 Check-in from an agent (cleanup-scratch-issues skill) on behalf of RUNNER_NAME — @ASSIGNEE, this
issue is assigned to you but hasn't been updated in over two weeks. Is it still active? If not,
please update its status or unassign it. (Automated backlog-hygiene review.)
```

## Step 8 — Report the result

Reply with a table: each processed issue → the action taken (`Labels added`, `Agent`,
`Needs scoping`, `Comment posted`, or `Skipped` with the reason, e.g. "no longer assigned"). Give the
running totals per action. If a connector label was created, note it.

## Guardrails

- **Additive only.** The sole mutations are: adding labels to an issue, adding the `Agent` /
  `Needs scoping` labels, optionally creating one connector label, and adding comments. Never edit a
  description, remove a label, change status, or delete anything.
- **Labels are a full replacement.** `save_issue.labels[]` overwrites the whole set — always pass the
  **union** of the issue's current labels plus the new one, or you'll silently drop labels.
- **Never invent a label.** Apply only labels that exist in the Step 0 live set. A connector with no
  label is a reported *gap* that the user must approve creating — not something to fabricate.
- **Four independent gates.** Labels (Gate 1), `Agent` (Gate 2), `Needs scoping` (Gate 3), and
  check-in comments (Gate 4) are each confirmed separately; a `Skip` on one performs no writes for it.
- **Re-verify before commenting.** At Gate 4, confirm the issue is still Backlog/To-Do and still
  assigned before posting; skip and note otherwise. Safe to re-run.
- **Every comment is attributed** — assignee + RUNNER_NAME + the agent note.
- **When unsure, report rather than act.** Surface a borderline issue in the report and let the user
  decide; don't apply a label or post a comment you're not confident about.
