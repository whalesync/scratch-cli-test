---
name: sync-bruno-collection
description: Detect changes to the Scratch server's REST API and update the Bruno collection at tools/bruno so it stays in sync — add a .bru for a new endpoint, remove one for a deleted endpoint, and fix the url/body/query for a changed route or DTO. Reports the drift first and only applies edits after one confirmation. Edits ONLY tools/bruno/** (never api-reference.md, never server code). Use when the user changes a controller/DTO and wants the Bruno collection updated, asks to sync / refresh / update the Bruno API collection, or to audit it for drift.
user-invocable: true
argument-hint: "[--audit | <base-ref>]"
allowed-tools:
  - Bash(git diff:*)
  - Bash(git log:*)
  - Bash(git status:*)
  - Bash(git merge-base:*)
  - Bash(git rev-parse:*)
  - Bash(find:*)
  - Bash(grep:*)
  - Bash(rg:*)
  - Bash(ls:*)
  - Bash(npx @usebruno/cli:*)
  - Read
  - Edit
  - Write
  - AskUserQuestion
---

# Keep the Bruno API collection in sync with the server

This skill compares the Scratch server's REST surface against the hand-maintained Bruno collection at `tools/bruno/` and updates the collection to match: it adds a `.bru` file for a new endpoint, removes one for a deleted endpoint, and fixes the `url` / `body:json` / `params:query` of a request whose route or DTO changed. Follow the steps in order.

> **Scope guardrail.** This skill edits **only** files under `tools/bruno/**`. It **never** edits `server/src/assets/api-reference.md`, controller code, DTOs, or any other server/shared-types file — it only *reads* those to learn the truth. It **reports the drift first and applies nothing until the user confirms at the Step 5 gate.** Never write a secret (token, admin key) into a committed `.bru` file.

Companion reference — read it before Step 2: [reference.md](reference.md) carries the folder→controller map, the excluded-surface list, the route→URL rule, and the copy-paste `.bru` templates.

## Step 0 — Preflight & mode

1. Confirm the collection exists: `ls tools/bruno/`. If it's missing, stop and tell the user there's no Bruno collection to sync.
2. Determine the mode from the argument:
   - **No argument** → **branch-diff mode** (default). Compute the base ref: `git merge-base origin/master HEAD` (if that fails, fall back to `origin/master`, then `master`). This is "sync the collection for the API changes on my current branch."
   - **A git ref argument** (e.g. `HEAD~5`, a tag, a branch) → branch-diff mode against that ref instead.
   - **`--audit`** → **full re-audit mode**: ignore git and re-scan the entire controller surface against the entire collection to surface any accumulated drift.
3. State which mode and base ref you're using before proceeding.

## Step 1 — Gather the changed REST surface

**Branch-diff mode:** diff the source-of-truth files against the base ref:

```bash
git diff <base>...HEAD -- \
  'server/src/**/*.controller.ts' \
  'packages/shared-types/src/dto/**' \
  'server/src/**/dto/*.dto.ts' \
  'server/src/assets/api-reference.md'
```

- From the **controller** hunks, reconstruct each affected endpoint as `{METHOD full-url ← DTO-or-inline-body}`. Build the full URL with the **route→URL rule** in `reference.md` (class `@Controller('prefix')` + method `@Verb('subpath')`, no global prefix; watch nested prefixes like `@Controller('workbooks/:workbookId/syncs')`).
- From the **zod DTO** hunks (`packages/shared-types/src/dto/**`), note which request/response *shapes* changed — this is where a body or query field actually changes. Trace which route uses a changed schema via its `createZodDto(<schema>)` bridge in `server/src/**/dto/*.dto.ts`.
- Treat an `api-reference.md` hunk only as a *signal* (payload/title source); do not edit that file.

**Audit mode:** enumerate both sides and diff the sets.

```bash
# Routes (source of truth), excluding the excluded controllers from reference.md
grep -rnE '@Controller\(|@(Get|Post|Patch|Put|Delete)\(' server/src --include='*.controller.ts'
# Existing collection endpoints
find tools/bruno -name '*.bru' -not -name 'folder.bru' -not -name 'collection.bru'
```

Read each request `.bru`'s verb block + `url:` to get its `{METHOD url}`, then compare against the reconstructed route set.

## Step 2 — Map each changed endpoint to its Bruno target

Using the **folder→controller map** in `reference.md`, for each changed/added/removed endpoint determine:
- the target **folder** under `tools/bruno/`,
- the target **`.bru` filename** — prefer the route title used in `api-reference.md` (e.g. `List Workbooks.bru`); otherwise derive a clear title from the handler/DTO name,
- whether the endpoint belongs to an **excluded surface** (webhooks, MCP, git proxies, dev-tools/code-migrations/cron/workers) — if so, **skip it** and record the reason for the report.

## Step 3 — Classify the drift

Label every endpoint:
- **NEW** — route exists in the server, no matching `.bru`.
- **REMOVED** — a `.bru` exists, the route no longer does.
- **CHANGED-PATH** — the URL (or a path param) changed.
- **CHANGED-BODY** — the request body shape changed (added/removed/renamed field, type change).
- **CHANGED-QUERY** — query params changed.
- **OK** — no action needed.

For **NEW** and **CHANGED-BODY**, source the example payload from `api-reference.md` when the endpoint is documented there; otherwise derive a minimal, realistic JSON body from the zod schema in `@spinner/shared-types` (only required fields + obvious examples; interpolate shared path vars like `{{workbookId}}`).

## Step 4 — Present the drift report

Show a table — **endpoint (METHOD url) · classification · target `.bru` · planned action** — plus a short list of skipped excluded endpoints (with reasons) and any `api-reference.md` doc-drift you noticed (reported only). **State plainly that nothing has been changed yet.** If everything is **OK**, say the collection is in sync and stop here.

## Step 5 — Gate, then apply

Ask **one** `AskUserQuestion`: apply these Bruno edits? On confirmation, apply each planned action using the `.bru` templates in `reference.md`:
- **NEW** → write a new `<Title>.bru` in the target folder. Use `meta { name / type: http / seq }` with `seq` = the next free integer in that folder (scan siblings); the verb block with the interpolated `url`, `body: none|json`, and `auth: inherit`; a `headers { Content-Type: application/json }` block **only** for JSON bodies; `body:json { … }` and/or `params:query { … }` as needed; a short `docs { … }`.
- **CHANGED-*** → edit only the affected block(s) of the existing `.bru` (the `url:` line, the `body:json` block, or the `params:query` block). Leave `meta.seq`, `auth: inherit`, and unrelated blocks untouched.
- **REMOVED** → delete the `.bru` file (use a shell `rm` via Bash, or note it for the user if deletion isn't permitted).

Conventions to honor exactly: keep `auth: inherit` (never re-declare the `Authorization` header — it's inherited from `collection.bru`); do **not** add `User-Agent`/`X-Scratch-Admin-Token` on individual requests (those live in `CLI/folder.bru` and `Internal - Whalesync/folder.bru`); mark optional/rare query params as `~`-disabled; never inline a secret value.

## Step 6 — Verify & summarize

1. `git status tools/bruno` → confirm only `.bru` files under the collection changed, and that `git diff server/src/assets/api-reference.md` is empty (you must not have touched it).
2. Optionally, best-effort validate a touched folder: `npx @usebruno/cli run "<Folder>" --env Local` from `tools/bruno` (needs a running local server on :3010 and a set `apiToken` — skip if unavailable, don't treat its failure as a skill failure).
3. Print a summary: `.bru` files added / edited / removed, endpoints skipped as excluded, and any noted `api-reference.md` doc-drift for the user to fix separately.

## Guardrails

- **Edits confined to `tools/bruno/**`.** Never edit `api-reference.md`, controllers, DTOs, or any other server/shared-types file.
- **Report before applying** — no `.bru` writes before the Step 5 confirmation.
- **Respect the excluded-surface list** in `reference.md`; skip those routes and say why.
- **Never commit secrets** into a `.bru` file; auth stays centralized (collection + the two special folders).
- **When a route's intent or body is ambiguous**, report it and ask rather than guessing a payload.
- **No connector-specific logic** in the collection — it's a generic REST surface.

## Reference

- [reference.md](reference.md) — folder→controller map, excluded surfaces, route→URL rule, `.bru` templates.
- `tools/bruno/README.md` — the collection's own setup/usage doc and excluded-surface rationale.
- `server/src/assets/api-reference.md` — endpoint titles + example request/response payloads (read-only source).
- `server/src/auth/{api-token,cli,scratch-admin}.strategy.ts` — the auth header facts the collection encodes.
