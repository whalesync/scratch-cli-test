# Live Export: incremental destination pulls (flag-gated, per connector) + the churn fixes found on the way

**Status:** In Progress (experiment shipped behind a flag; follow-ups below) · **Issue:** [DEV-11069 — [FR] Support incremental syncs](https://linear.app/whalesync/issue/DEV-11069) · **Branch:** `worktree-dev-11069-fr-support-incremental-syncs` · **Author:** Rob ODwyer · **Date:** 2026-08-28

## Problem

A Live Export run is a generated routine (`routines/run-<syncId>.yaml`): `discard-pending-changes → pull source → pull destination → sync → publish`. Every generated pull step was stamped `fullPull: true`, so each run re-downloaded the whole destination even though Notion (and other connectors) support incremental pulls. DEV-11069 asks to trial incremental pulls for the destination side and understand the side effects — especially around deleted/archived destination records, which only a full pull reconciles.

While setting the trial up on an Attio → Notion export, two records re-published on **every** run regardless of pull mode. Both turned out to be Notion write-normalisation gaps, and both are now fixed.

## What shipped (4 commits on the branch)

| Commit      | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `9cd8526d9` | **Notion checkbox clears to `false`.** An Attio checkbox that was never set is `[]` → the `$[0].value` projection yields `null` → the Notion checkbox pack hint had no `emptyTemplate`, so the sync wrote a literal `null`; Notion reads an unset checkbox back as `{ checkbox: false }`, so the record diffed and re-published every run. Fix: `emptyTemplate: { type: 'checkbox', checkbox: false }` on the pack hint, plus the checkbox canonicalizer treats `null`/absent as `false`. Live `fetchJsonTableSpec` snapshot hand-patched (additive). |
| `4b8aff43a` | **Notion text canonicalizer ignores U+200B / U+FEFF.** Notion silently drops zero-width space and BOM on write; a seeded `zero​width` description came back as `zerowidth` and re-published forever. The `title`/`rich_text` canonicalizer now strips exactly those two characters before comparing. U+200D (ZWJ) is deliberately kept — it binds emoji sequences.                                                                                                                                                                                    |
| `0ed68af61` | **Regenerate the routine on every save.** `createRoutineFile` 409s when the file exists and the sync-draft apply path swallowed that as a warning, so a generator improvement never reached an existing Live Export. New `RoutineService.upsertRoutineFile` (create / update / _unchanged → no commit, no audit event_); apply uses it and logs the outcome.                                                                                                                                                                                          |
| `4bdc4ec5c` | **Flag-gated incremental destination pulls, per connector.** New per-user flag `ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL` whose **payload** names the destination connectors to enrol. Enrolled destination pull steps are written with an explicit `fullPull: false`; sources and un-enrolled destinations stay `fullPull: true`. Adds `FEATURE_FLAG_PAYLOAD_OVERRIDES_FOR_LOCAL_DEV` so payload-driven flags can be exercised locally.                                                                                                       |

## Key decisions

- **Gate in the generator, not the executor.** The flag is read when the routine is _saved_ and the choice is baked into the YAML (`fullPull: true|false`), so the file a user reads states the mode, and flipping the flag takes effect on the next save (which now regenerates the routine). The executor (`routine-executor.service.ts`) is unchanged: `fullPull` falsy → incremental; the pull job still demotes to full on bootstrap and for tables the connector can't pull incrementally.
- **Explicit `fullPull: false`** rather than omitting `options` — an absent option next to `fullPull: true` steps reads like an oversight.
- **Payload is a plain array**, not an object: `["NOTION"]`, `["notion", "AIRTABLE"]` (case-insensitive), `["*"]` for every connector, `[]` for none. Anything else is _malformed_ → nothing enrolled, logged — a typo can never opt everything in. PostHog payloads can differ per release condition, so one flag enrols different connectors for different users. Parser lives in `server/src/sync-draft/live-export-incremental-destination-pull.ts`.
- **Fail-closed everywhere:** no user row, unmatched user, PostHog outage, malformed payload → full pulls.
- **Not the Attio connector's problem.** Both churn fixes sit on the Notion side: `[]` and U+200B are the source API's verbatim data (Connector Prime Directive); the destination that normalises them is where equality must be defined. Canonicalizers are equality-only — nothing written to disk or sent to a service changes.
- **Deletion reconciliation is knowingly deferred.** Only a full pull runs `deleteStaleFiles`; an enrolled destination gives up the self-heal re-create for records deleted/archived on the destination until a full pull runs. This is the trade-off DEV-11069 is meant to explore, not a solved problem.

## How to enable and verify

Local server (`server/.env`, then restart `yarn dev`):

```
FEATURE_FLAG_OVERRIDES_FOR_LOCAL_DEV=ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL=true
FEATURE_FLAG_PAYLOAD_OVERRIDES_FOR_LOCAL_DEV={"ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL":["NOTION"]}
```

Test/prod: create the PostHog flag with a JSON payload on its release condition (`/scratch-posthog`). Then re-save the Live Export in dusky (no dusky change needed — it already sends `createRoutine: true`).

Confirm the routine was regenerated (the workbook config repo holds it):

```bash
R=local/scratch-git-repos/<org>/<wkb>/<wkb>.git
git -C $R show main:routines/run-<syncId>.yaml     # "Pull Destination" step should read fullPull: false
```

Confirm the pull mode actually used — the first run after enabling is still full (bootstrap), the second is incremental:

```bash
psql postgresql://postgres:postgres@localhost:5432/scratchpaper -X -At -F' | ' -c \
  "select id, \"createdAt\", data->>'pullMode' from \"Job\"
   where type='pull-linked-folder-files' and data->'dataFolderIds' ? '<dfd_id>'
   order by \"createdAt\" desc limit 3;"
```

The routine run's step snapshot (`RoutineRunStep.options`) records what was requested per step.

## Debugging recipe that found both churn bugs

A `Publish V2 edit batch` commit whose only delta is `last_edited_time` means "we published something the destination normalised back to what it already had" — a canonicalizer gap. The publish job tags the state it worked from, so the real diff is:

```bash
R=local/scratch-git-repos/<org>/<wkb>/<coa_destination>.git
git -C $R tag --points-at main | grep main_plan_          # → planId
git -C $R diff main_pre_plan_<planId> dirty_plan_<planId> -- <folder>/<page>.json   # sync output vs stored
```

`dirty_plan_*` = what the sync wrote; `main_pre_plan_*` = stored before publish; `main_plan_*` = Notion's echo after. Hunt invisible characters with `| grep -o 'zero.\{0,3\}width' | xxd`.

## Follow-ups

- **Regenerate the Notion live snapshot** — `cd server && yarn run test:integration notion-connector -u` with a `NOTION_API_KEY`; the checkbox `emptyTemplate` was hand-patched and the suite only runs post-deploy.
- **Create the PostHog flag** (`ENABLE_LIVE_EXPORT_INCREMENTAL_DESTINATION_PULL`, boolean + JSON payload) before enrolling anyone outside local dev.
- **DEV-11069 open questions**, now testable end-to-end: do archived Notion pages surface in an incremental window; a "recreate on destination 404" setting; side effects of archive/delete with incremental on vs off; a periodic full pull (e.g. a second scheduled routine or "every Nth run is full") so `deleteStaleFiles` still runs.
- **One-off full sync (DEV-11407, done server-side):** `POST /workbooks/:id/routines/trigger { filePath, forceFullPull: true }` (api-client: `routine.trigger(workbookId, filePath, { forceFullPull: true })`) forces every pull step of that run to full by overriding `options.fullPull` on the run's step snapshot — the YAML stays incremental. Chosen over a second `run-<syncId>-full.yaml` because the active-run lock, run history, and schedules are all keyed per routine file (a twin file could run concurrently with the incremental one). The dusky "full sync" button + tooltip and the Notion trashed-record → 404 detection are still open.
- Decide whether the _source_ pull should also be flag-enrollable (it stays full today).
- `notion/STATE.md` already fails `prettier --check` at HEAD (pre-existing table formatting); the new bullets were inserted without reformatting the file.
- The Notion standalone-pages backup table can't pull incrementally (Search API has no modified-since filter) — it correctly demotes to full even when enrolled.

## Environment note (same session, committed separately by the author)

Claude Code worktrees symlinked `node_modules` to the main checkout, which pinned `@spinner/shared-types` (and `.prisma`) to whatever the main checkout last built — `yarn dev` in a worktree then failed on types that existed in `src` but not in main's stale `dist`. `.claude/settings.json` no longer symlinks `node_modules`; `.worktreeinclude` copies it instead (`acef10518`, `d94a61eef`).
