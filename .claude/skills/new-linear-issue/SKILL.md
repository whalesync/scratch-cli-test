---
name: new-linear-issue
description: Create a Linear issue for the Scratch project with the team's conventions baked in — always the Scratch project, Backlog status by default, Low priority by default, a t-shirt size derived from complexity + testing effort, and no cycle. Use when the user asks to create / file / open a Linear ticket or issue for this repo.
user-invocable: true
allowed-tools:
  - mcp__linear-server__list_teams
  - mcp__linear-server__list_projects
  - mcp__linear-server__list_issue_statuses
  - mcp__linear-server__list_users
  - mcp__linear-server__get_user
  - mcp__linear-server__get_issue
  - mcp__linear-server__save_issue
  - AskUserQuestion
---

# Create a Linear ticket for Scratch

Creates a Linear issue in the **Scratch** project under the **Dev** team, applying this team's
conventions automatically. Follow the steps in order.

## Fixed values for this workspace

These are stable; use them directly rather than re-deriving each time. Spot-check with a read-only
call only if a write fails.

| Thing | Value |
| --- | --- |
| Team | `Dev` (id `b4e2b7f8-c4c2-4aaa-848c-e306f07c1a8f`) |
| Project | `Scratch` (id `41604a71-549f-4794-ab01-1b7f3b82d2dc`) |
| Default status | `Backlog` (id `81cb87fa-4a97-464c-afef-846b8c24c87f`) |

> ⚠️ There are decoy projects named **`Scratch (Old)`** and **`Scratch User Tracker`**. Always set
> the project to the exact id `41604a71-549f-4794-ab01-1b7f3b82d2dc` (or the exact name `Scratch`),
> never a fuzzy match.

### Priority (`priority` field — integer)

`0`=None, `1`=Urgent, `2`=High, `3`=Medium, `4`=Low. **Default to Low (`4`).**

### Size (`estimate` field — integer, Linear t-shirt scale)

Pick the size from the estimated **implementation complexity + testing effort**:

| Size | `estimate` | When |
| --- | --- | --- |
| XS | `1` | A quick change that needs little testing, or is already well covered by existing unit/integration tests. |
| S | `2` | A larger change, ~a day of effort to build, test, and iterate. |
| M | `3` | A big task, a few days, lots of complexity. |
| L | `4` | Reserved for large tasks — ~a week, likely subtasks, migrations, research, many moving parts. |

Propose the size yourself based on the ticket content, then confirm it with the user (see Step 3).
**When there isn't enough information to judge complexity, default to XS (`1`)** and let the user
bump it up.

### Cycle

**Never set `cycle`.** Leave it unset.

## Step 1 — Verify the Linear MCP is connected and authenticated

Before anything else, confirm the Linear MCP works by making one cheap read-only call:

```
mcp__linear-server__list_teams({ "query": "Dev" })
```

- If the tool is **not available at all** (no `mcp__linear-server__*` tools), tell the user the Linear MCP
  isn't configured for this session and stop. They need to add/enable the Linear MCP server (e.g.
  via `claude mcp` / their MCP config) and re-authenticate.
- If the call **errors with an auth/permission failure** (401/403, "unauthorized", "not
  authenticated", token expired), tell the user Linear authentication is invalid or expired and they
  need to re-authenticate the Linear MCP. Stop.
- If it **succeeds**, continue.

## Step 2 — Gather the ticket content

From the user's request, draft a clear **title** and a **description** (Markdown — use real
newlines, not `\n`). If the user only gave a one-liner, write a short description that captures the problem/goal; pull in concrete file paths or context from the repo when relevant. Don't over-invent scope.

## Step 3 — Ask the user the required questions

Use a single `AskUserQuestion` call with these questions (skip any the user already answered in their
request):

1. **Assignee** — "Assign this ticket to you, or leave it unassigned?"
   - Options: `Assign to me`, `Unassigned`.
2. **Priority** — "What priority?" Options: `Low (default)`, `Medium`, `High`, `Urgent`.
   (Default to Low if they don't care.)
3. **Size** — present your proposed size with a one-line justification and let them confirm or
   change it. Options: `XS`, `S`, `M`, `L` (mark your recommendation as recommended and list it
   first). If you can't judge complexity from the available info, recommend **XS**.

Status defaults to **Backlog** — only ask about status if the user explicitly referenced a different
state (e.g. "put it in To Do", "this is in progress").

## Step 4 — Create the issue

Call `mcp__linear-server__save_issue` **without an `id`** (passing `id` would update an existing issue):

```
mcp__linear-server__save_issue({
  "team": "b4e2b7f8-c4c2-4aaa-848c-e306f07c1a8f",
  "project": "41604a71-549f-4794-ab01-1b7f3b82d2dc",
  "title": "<title>",
  "description": "<markdown description>",
  "state": "Backlog",            // or the user-specified status
  "priority": 4,                  // from Step 3 (default Low)
  "estimate": 1,                  // from Step 3 t-shirt size → 1/2/3/4
  "assignee": "me"                // omit entirely if Unassigned
})
```

Notes:
- Use `assignee: "me"` to self-assign; **omit the field entirely** to leave it unassigned (don't
  pass `null` unless removing an assignee on an update).
- Do **not** pass `cycle`.

## Step 5 — Give the user the link

`save_issue` returns the created issue including its `url` and identifier (e.g. `DEV-1234`). Reply
with the identifier and a clickable link, e.g.:

> Created **DEV-1234** — [<title>](https://linear.app/whalesync/issue/DEV-1234) (Scratch · Backlog ·
> Low · size S, assigned to you)

Confirm the key fields you set so the user can sanity-check at a glance.
