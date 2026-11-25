# DEV-13025: scratchmd and Scratch Desktop get table specs and default views from the server

> **Un-cancelled 2026-11-25.** On 2026-11-24 this design was cancelled because the CLI and Desktop were going to be sunset. On 2026-11-25 the sunset was put on hold, and this design is being built so the table specs can be removed from git completely (DEV-13027, then DEV-13028). Step 0 is decided (build it). MR 0 is folded into MR 2. A review of the CLI and Desktop wiring on 2026-11-25 found one gap and several risks; the fixes are in [Wiring review fixes](#wiring-review-fixes-2026-11-25).

**Status:** In Progress. MR 1 (server) merged 2026-11-25 as [!3497](https://gitlab.com/whalesync/spinner/-/merge_requests/3497) (`0b324eb01`); the prod divergence report matched all 2,007 folders and the import dry run would import 0. MR 2 (CLI and Desktop) is on branch `dev-13025-cli-desktop-table-specs-from-server` (see [MR 2 implementation notes](#mr-2-implementation-notes)). **Created:** 2026-11-24. **Author:** Chris Hoefgen (with Claude). **Linear:** [DEV-13025](https://linear.app/whalesync/issue/DEV-13025) (parent DEV-12616; unblocks DEV-13027 and DEV-13028).

All references are to `7c8ad12be`. The code facts below come from reading the code. Prod sizes and traffic come from read-only DB queries, load balancer logs, and PostHog. Nothing was reproduced locally.

## Summary

- **Decided (2026-11-25).** Build this design. Specs leave git; the "Prefer files for user data" wording changes in DEV-13028. The CLI and Desktop sunset is on hold.
- **The `validation.json` fix ships in MR 2.** Today every publish deletes users' custom validators from the CLI cache. MR 2 makes `materialize_local_repo` ignore `.scratch/` keys entirely, which fixes it, so the separate MR 0 is folded in.
- **Server.** Add one bulk endpoint, `GET /cli/v1/workbooks/:id/table-specs[?connectorAccountId=][&metadataOnly=true]`. It reads only Postgres. For each linked folder, grouped by connection, it returns the stored spec and default view as the exact stored strings, a SHA-256 of each, and an explicit status (`present`, `absent`, or `unreadable`).
- **CLI.** `scratchmd` becomes the only writer of `schema.json` and `views/default.json` in the cache it already uses, `<ws>/.scratch/connections/scratch/<conn>/<folder>/`. It writes the server's bytes verbatim and atomically, with at most two calls per refresh. Every CLI reader and every Desktop reader keeps reading the same files, so none of them change.
- **Git stops writing the cache:**
  - Full-tree `materialize_local_repo` ignores `.scratch/` keys.
  - The 12 `sync_schema_files_from_worktree` call sites and the function itself go away. There is no old-server fallback.
  - `files revert-plan` reads `idPath` from the cache.
- **No manifest.** The CLI never edits specs. The server listing plus a hash of the bytes on disk decide every write and delete, so re-running always converges.
- **Desktop.** One line: pass the app version to the bundled `scratchmd` so it shows up in the User-Agent. Then ship a release and raise `MINIMUM_SUPPORTED_DESKTOP_VERSION`.
- **Gate.** `scratchmd` gets a versioned User-Agent. From then on, any request whose UA is exactly `Scratch-cli/1.0` comes from an old binary. Old binaries won't all go away by themselves, so a server-only HTTP 426 guard is planned as the normal way to end the tail. DEV-13027 starts once load balancer logs show no unblocked legacy traffic.
- **Size.** Server S, CLI M, Desktop XS. Expect about 6 weeks of calendar time from the CLI merge to the DEV-13027 gate, mostly release cadence and the measurement window.

## Problem and goal

Since DEV-12616, Postgres (`DataFolderTableSpec`) is the source of truth for each folder's table spec and default view. The server still mirrors every write to `.scratch/<folder>/schema.json` and `views/default.json` on `main` and `dirty` (`TABLE_SPEC_GIT_MIRROR_ENABLED`). The only remaining reason is that `scratchmd`, and Desktop through its bundled `scratchmd`, get specs from their git clone. (The web "Show hidden files" viewer is DEV-13026.)

Goal: `scratchmd` fetches specs and default views from the server and writes them into its existing cache. After that:

- validators, the folder index, `record-tree`, `syncs validate-local`, `files revert-plan`, and Desktop all work with no git copies;
- the mirror can be turned off (DEV-13027);
- the transition code can be removed (DEV-13028).

Old binaries must not degrade silently in a way nobody measures.

## Current state

### The three local copies

| Copy | Location | Maintained by |
| --- | --- | --- |
| Git blob | `main:.scratch/<folder>/schema.json`, `.../views/default.json` | Server mirror, `data-folder-table-spec-store.service.ts:668`, `:692` |
| Worktree | `<ws>/<conn>/.scratch/<folder>/…` | `update_main_worktree_after_pull` does `reset --mixed`, then `checkout <hash> -- .scratch` (`files.rs:8832`, `:8857`). Files that main deleted stay on disk as untracked copies, and a missing pathspec counts as success (`local.rs:526-552`). |
| Cache | `<ws>/.scratch/connections/scratch/<conn>/<folder>/…`. A root folder `/` maps to `<cache>/schema.json` (`folder_index.rs:402-419`). | The two writers below |

### Who writes the cache

- **`review_ops::sync_schema_files_from_worktree`** (`review_ops.rs:1190-1238`):
  - copies worktree `schema.json` and `views/*.json` into the cache;
  - is non-atomic and always rewrites, so mtimes always move;
  - never deletes, and does nothing when the worktree has no `.scratch`.
  - It has 12 call sites: `workspaces.rs:859`, and `files.rs:1039`, `:3083`, `:3451`, `:3553`, `:3654`, `:4156`, `:6781`, `:7765`, `:7878`, `:7979`, and `:8067`.
  - A `--skip-folder-index` pull never syncs the cache. The call at `:1039` sits inside the `!skip_folder_index` gate. The one at `:6781` is gated on `moved`, which is always false there, because `download_single_repo` has already advanced `refs/heads/main`.
- **Full-tree `materialize_local_repo`** (`files.rs:8184-8231`):
  - maps `.scratch/<rel>` to the cache (`:8194-8202`);
  - deletes every current key that is missing from the git target (`:8219-8229`).
  - `current_map` holds every non-hidden cache file (`review_ops.rs:1140-1170`), and that includes `validation.json`.
  - Full-tree mode runs on the first materialization of a connection (`old_main_hash` is `None`, `files.rs` ~6905-6916), on every `files reconcile-after-publish` (Desktop runs it after each publish), and on every CLI `files publish` (`reconcile_accepted_after_publish`, `:6059`).
- **Existing bug (from reading the code, not reproduced): custom validators are deleted after every publish.**
  - The delete loop removes `.scratch/<folder>/validation.json` because git never tracks it.
  - Desktop re-seeds only its two auto-seeded validators (`validation-config.ts:132-135`).
  - The generated agent docs tell users to "add your rules here" (`generate_docs.rs:703-715`).
  - Separately, `repair_connection_local_repo` (`workspaces.rs:926`) removes the whole cache directory, including `validation.json`.

### Who reads the cache

- **CLI readers:**
  - `enforce_schema` (`validators/mod.rs:737`) silently does nothing when the spec is missing.
  - Folder-index numeric affinity and the DEV-10518 hash (`folder_index.rs:429-439`, SHA-256 of raw bytes): a byte change clears that folder's `enforce_schema` results. `reconcile_enforce_schema_results_after_schema_change` only clears results; it doesn't re-run validation (`folder_index.rs` ~3150-3160).
  - `record-tree` fails hard when the spec is missing (`record_tree.rs:100-103`).
  - `syncs validate-local` and `validation dry-run` also read the cache.
- **`files revert-plan`** reads `idPath` from git `main`, not the cache (`files.rs:2426`, `:5486-5509`). It falls back to `id`, which gives phantom diffs for connectors whose id root isn't `id`.
- **Desktop** reads only the cache (`scratch-desktop/src/main/local-files.ts:648-702`), and `getFolderReferenceInfos` reads every folder's spec. All cache writes except `validation.json` come from the bundled CLI. The main process makes no HTTP calls. Desktop revalidates only newly seeded folders on its own (`index.ts:649-667`).
- Nothing reads the worktree `.scratch` except `sync_schema_files_from_worktree`. `load_worktree_into_path_contents_map` skips dot-directories.

### Server

- `GET /cli/v1/workbooks/:id` (`cli-workbook.controller.ts:125-157`):
  - is called by pull and init, but not by publish, `reconcile-after-publish`, or upload;
  - uses `assertWritableWorkbook` and returns `connectorAccounts[].dataFolders[] {id, name, path}`, including folders with a null path.
  - The Rust structs have no `deny_unknown_fields` (`api/mod.rs:379-427`), so additive fields are safe.
- `GET /data-folder/:id/schema` is per-folder and outside `/cli/v1`. It returns a re-serialized object, and it turns read errors into 404 (`data-folder.service.ts:1146-1170`).
- **Rate limit.** `ApiRateLimitGuard` on `CliWorkbookController` allows 60 requests per 60 s per user by default (`api-rate-limit.guard.ts:27`). The git proxy (`:191`, two or three requests per connection fetch) is on the same controller, so it shares that bucket. CLI GET retries on 429 wait 250 ms, then 1 s, and ignore `Retry-After`. A prod workbook can have 110 classic folders, so specs need a bulk call.
- **Stored content:**
  - It is TEXT holding `formatRecordJson(x)` = `JSON.stringify(x, null, 2) + "\n"` (`packages/shared-types/src/format/index.ts:16-18`).
  - The mirror writes the stored bytes, but `writeSchemaToGit` skips the commit when git already equals the new spec ignoring `generatedAt` (`scratch-git.service.ts:628-643`). A row first created by a pull, refresh, or publish-plan build (not by the git-import) has a fresh `generatedAt`, so its git bytes and therefore today's cache bytes differ from the stored bytes. They never converge, because the DB also skips `generatedAt`-only writes.
  - Other byte differences: DEV-10092 shim imports, git-only writes from older revisions, and Windows CRLF caches.
  - `updatedAt` is row-level, moves on view-only changes too, and is set by several app clocks. It works for tie-breaks and equality checks but not for "changed since" queries.
- **Postgres already has everything git has.** The read-only divergence report matched every row on prod (2,007) and test (494). It compares views with `isEqual(storedView, gitView)` (store `:342-343`), so none of the 236 rows with a null view has a view in git. The 20 classic folders with no row have no spec in git either. So the store's git fallbacks return nothing that Postgres lacks.
- Prod sizes:
  - 2,007 rows; 236 have a null view.
  - Per-workbook spec and view total: 140 KB at p50, 4.66 MB at most.
  - Nothing compresses responses.
- The scratch-git index build still reads git for folders with no row, specs with a lone UTF-16 surrogate, and bad keys (store `:437-474`).

### Client versions and distribution

- **CLI:**
  - `scratchmd` sends the constant `User-Agent: Scratch-cli/1.0` (`api/mod.rs:203`, `:313`).
  - `CliStrategy` accepts a UA starting with `scratch-cli/` or `scratchdesktop/`, or containing `electron/` (`cli.strategy.ts:32`). It guards only `cli-auth`; everything else uses `ScratchAuthGuard` (API token or Clerk).
  - Bruno also sends `Scratch-cli/1.0` (`tools/bruno/CLI/folder.bru:7`), and the Bruno sync skill (`.claude/skills/sync-bruno-collection/reference.md:177`) and `tools/bruno/README.md:72` hard-code it.
  - The standalone CLI ships through GitHub releases (`whalesync/scratch-cli`), a Homebrew formula (`whalesync/homebrew-scratch-cli`), and a Scoop bucket (`scratch-git-2/scripts/release_public.sh`). Those builds inject the real crate version. Desktop's bundled build does not, so it reports 0.1.0.
  - Desktop can install a `scratchmd` symlink to its bundled binary (`isCliSymlinkInstalled`). Terminal users of that symlink upgrade with Desktop.
- **Desktop:**
  - It ships through its own Homebrew cask (`whalesync/homebrew-scratch-desktop`, `scratch-desktop/scripts/update_homebrew_cask.sh:40`) and auto-update. Linux builds are AppImage and `.deb`.
  - It can be forced to upgrade through `MINIMUM_SUPPORTED_DESKTOP_VERSION` (`server/src/experiments/flags.ts:180`). That check fails open, and it only locks the renderer (`App.tsx:177-210`). The main process keeps running `files download` hourly with the old bundled `scratchmd` (`index.ts:1705-1711`, `auto-download-scheduler.ts:19-22`) until the app restarts.
  - Releases are weekly from `prod` (`1df2cd3db`). That commit also says the team is no longer actively working on Desktop or the CLI.
- **Traffic, about 30 days:**
  - 874 `Scratch-cli/1.0` requests from 29 IPs;
  - `cli_download` from 5 external users;
  - 9 Desktop versions seen.

## Options considered

Scores are 1 to 5; higher is better. "Cost" accounts for Desktop and the CLI being in maintenance mode. "Principles" weighs "Prefer files for user data" heavily: A, B, C, and E all remove spec files from git and need the principle edited.

| Option | Correctness | Old-client safety | Cost | Principles | Enables 13027 / 13028 | Total | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A. Bulk endpoint with metadata mode, stateless CLI writer into the existing cache | 5 | 3 | 3 | 3 | 4 | 18 | **Base of the chosen design.** Smallest correct change set; its rollout gate is too weak on its own. |
| B. Put spec content on `GET /cli/v1/workbooks/:id` | 3 | 3 | 4 | 3 | 4 | 17 | Cheapest. But a spec read failure would fail every pull, full content ships on every pull, publish doesn't call that route, and it drops the metadata mode the ticket asks for. |
| C. Endpoint plus manifest, 426 cutoff, and Desktop watcher and notice work | 4 | 5 | 2 | 3 | 4 | 18 | Best rollout. The manifest and Desktop changes add cost without changing the outcome. |
| D. Keep a `main`-only mirror forever, drop `dirty` writes | 4 | 5 | 5 | 4 | 1 | 19 | Keeps spec files and their history in git, and costs almost nothing. It doesn't enable DEV-13027 or DEV-13028, so it's the right call only if Desktop and the CLI are sunset within about a quarter. |
| E. Turn the mirror off with no client work | 1 | 1 | 5 | 1 | 2 | 10 | Rejected: core flows break silently on old and new binaries alike. |

D scores highest on paper because it gives up the goal. The step-0 decision (see [Rollout and gates](#rollout-and-gates)) chooses between D and the design below. A and C tie, but C's lead is all rollout policy, and that grafts onto A at XS cost. The design below is A with these grafts:

- **From C:** client classification in telemetry, the 426 guard, freeze-then-delete for DEV-13027, measurable gates, and the Desktop env var set before the `isPackaged` early return.
- **From B:** a transitional `main_map` fallback in `revert-plan`.

It also simplifies A:

- The endpoint reads only Postgres. Postgres already holds everything git has (see [Server](#server)), so a git fallback would add a `ScratchGitService` dependency and a reads-flag dependency for no data.
- Content is fetched for the whole workbook (or one connection) in a single call, so there are no folder-id lists and no per-connection call fan-out.

## Design

### MR 0: stop deleting custom validators (folded into MR 2)

MR 2's change to `materialize_local_repo` (ignore every `.scratch/` key) supersedes the delete-loop rule below, so MR 0 doesn't ship on its own. The `repair_connection_local_repo` change and both tests still belong in MR 2.

- In the full-tree delete loop (`files.rs:8219-8229`), skip any `.scratch/` key other than `schema.json` and `views/*.json`. Keep every write as it is, so specs rewritten by a publish-plan build still reach the cache.
- In `repair_connection_local_repo` (`workspaces.rs:926`), keep each folder's `validation.json` instead of removing the whole cache directory. Remove everything else as today.
- Tests:
  - in the post-publish reconcile group (`tests/files.rs:3772-4430`), `validation.json` survives full-tree mode while a stale `schema.json` is still replaced;
  - repair keeps `validation.json`.

### Server

**Endpoint**

```
GET /cli/v1/workbooks/:workbookId/table-specs
    ?connectorAccountId=coa_...   (optional; limits the response to one connection)
    &metadataOnly=true            (optional; leaves out content)
```

**Response** (`CliWorkbookTableSpecsResponse`, a plain interface in `@spinner/shared-types`):

```json
{
  "formatVersion": 1,
  "workbookId": "wkb_abc",
  "connectorAccounts": [
    {
      "connectorAccountId": "coa_1",
      "dataFolders": [
        {
          "dataFolderId": "dfd_1",
          "path": "/Blog Posts",
          "storedRowUpdatedAt": "2026-11-23T18:02:11.123Z",
          "tableSpec": {
            "status": "present",
            "sha256": "9f2c…e1",
            "content": "{\n  \"id\": {\n …\n}\n"
          },
          "defaultView": { "status": "absent" }
        },
        {
          "dataFolderId": "dfd_2",
          "path": "/",
          "storedRowUpdatedAt": "2026-11-20T09:14:00.000Z",
          "tableSpec": { "status": "unreadable", "reason": "stored-content-not-a-json-object" },
          "defaultView": { "status": "absent" }
        }
      ]
    },
    { "connectorAccountId": "coa_2", "dataFolders": [] }
  ]
}
```

**Statuses** (the same set for `tableSpec` and `defaultView`):

| Status | Meaning | CLI action |
| --- | --- | --- |
| `present` | The stored row has this content | Write if the local bytes differ |
| `absent` | No row, or a row with a null view | Delete the owned local file |
| `unreadable` (`reason`) | The stored content isn't a JSON object | Keep the local file and warn |

`absent` is always backed by Postgres, the source of truth. Git evidence never produces it, so neither the reads flag nor the mirror flag can turn a missing git copy into a delete.

**Byte and hash rules**

- `content` is the stored TEXT, sent as a JSON string and never parsed and re-serialized. A nested object would be re-serialized by NestJS and would change the bytes the DEV-10518 hash covers.
- Lone surrogates are already stored as `\uXXXX` escape text, so they pass through unchanged.
- `sha256` is the lowercase hex SHA-256 of the UTF-8 bytes of `content`. That equals `compute_schema_hash` of the written file. It is computed in Node in both modes, so the two modes can't disagree.
- `metadataOnly=true` gives the same body without `content`.
- `storedRowUpdatedAt` is used only to break ties between duplicate paths. Clients must not use it for change detection.
- `formatVersion` changes only on a breaking change. New fields are additive.
- Connections are ordered by id, and folders by `path`. The response is always a complete listing for its scope. A connection with no linked folders appears with an empty `dataFolders`, so "no folders" and "not returned" can't be confused.

**Query and scoping**

- New store method: `DataFolderTableSpecStoreService.readTableSpecsAndDefaultViewsForCliCacheRefresh(workbookId, { connectorAccountId?, includeContent })`. It lives in the store because only the store may read `storedTableSpecRow`.
- It reads only Postgres and ignores `TABLE_SPEC_POSTGRES_READS_ENABLED`. It has no `ScratchGitService` dependency.
- It uses the same connections as `GET :id`, and the folders among them with a non-null path: `connectorAccount.findMany({ where: { workbookId, id?: connectorAccountId } })`, then each account's `dataFolders` with a non-null `path`, selecting `storedTableSpecRow { tableSpecContent, defaultViewContent, updatedAt }`.
- A `connectorAccountId` that isn't in the workbook returns 404. That check uses the same `where`, so DEV-12670's gap can't recur here.
- The controller calls `assertReadableWorkbook`, matching the git proxy.
- Unlike the index-build bulk read (`:422-504`), no folder is ever dropped. Every folder gets an explicit status.

**Wiring**

- New `server/src/cli/cli-table-specs.controller.ts`: `@Controller('cli/v1/workbooks')` with `@UseGuards(ScratchAuthGuard, ApiRateLimitGuard)`.
- `CliModule` imports `DataFolderTableSpecStoreModule` (`cli.module.ts:29-47`). That module is a leaf, so there is no cycle.
- Shared types:
  - `cliListWorkbookTableSpecsQuerySchema` (`connectorAccountId`, `metadataOnly: z.stringbool().optional()`), bridged with `createZodDto`;
  - the `CliWorkbookTableSpecsResponse` interface;
  - a server factory, `CliWorkbookTableSpecsEntity.from(...)`.

**Divergence report: add a byte check.** Extend the read-only `data-folder-table-spec-git-divergence-report` with a count of folders whose git `schema.json` bytes differ from the stored bytes, and the same for `views/default.json`. Matching folders count too (a `generatedAt`-only difference matches but differs in bytes). That measures how many caches the first refresh will rewrite (see [Risks](#risks-and-open-questions)).

**Telemetry and client identification**

- New `server/src/cli/scratchmd-client-identification.ts`: `classifyScratchmdClientFromUserAgent(userAgent)` returns `{ scratchmdClientKind: 'legacy-scratchmd' | 'scratchmd' | 'other', scratchmdVersion?, scratchDesktopVersion? }`. `legacy-scratchmd` means the UA is exactly `Scratch-cli/1.0`.
- `trackCliListWorkbooks` (`posthog.service.ts:498`, called at `cli-workbook.controller.ts:130`) gets those properties. Publish, `reconcile-after-publish`, and upload don't call that route, so PostHog undercounts legacy clients. **Load balancer logs are the authoritative gate evidence**; PostHog is supplementary.
- New event `cli_list_table_specs` through `trackCliListWorkbookTableSpecs(actor, workbookId, { connectorAccountId, metadataOnly, connectionCount, folderCount, presentFileCount, absentFileCount, unreadableFileCount, contentBytes, ...client })`. The file counts cover both files of every listed folder, and are flat so HogQL can filter on them. It is a read, so there is no audit log.
- Bruno:
  - add a `.bru` for the endpoint;
  - change `tools/bruno/CLI/folder.bru:7` to `Scratch-cli/1.0 bruno` so internal calls don't count as legacy traffic;
  - update `.claude/skills/sync-bruno-collection/reference.md:177` and `tools/bruno/README.md:72` to match, so the sync skill doesn't restore the legacy UA.
- Fix the stale comments in `cli.strategy.ts:18` and `cli-auth.guard.ts:6`, which still say the UA must be exactly `Scratch-cli/1.0`.

### CLI (`scratch-git-2`)

**Wire types and client** (`api/mod.rs`)

- `ApiClient::list_workbook_table_specs(workbook_id, connector_account_id: Option<&str>, metadata_only: bool)`, built on `get_query`, so it gets the standard GET retries.
- Structs:
  - `WorkbookTableSpecsResponse { format_version, workbook_id, connector_accounts }`;
  - `WorkbookTableSpecConnection { connector_account_id, data_folders: Vec<serde_json::Value> }`. Each folder is parsed separately into `WorkbookTableSpecFolder`, so one malformed entry (for example a missing `sha256`) marks only that folder unreadable instead of failing the whole listing.
  - `TableSpecArtifact`, an internally tagged enum (`tag = "status"`, kebab-case): `Present { sha256, content: Option<String> }`, `Absent`, `Unreadable { reason }`, and `#[serde(other)] Unknown`. `Unknown` is treated like `Unreadable`.

**User-Agent** (`api/mod.rs:203`, `:313`)

- New value: `Scratch-cli/1.0 scratchmd/<CARGO_PKG_VERSION>`, plus ` scratch-desktop/<v>` when `SCRATCH_DESKTOP_APP_VERSION` is set.
- It keeps the `scratch-cli/` prefix `CliStrategy` checks, and it can never equal the legacy constant.

**Refresh module** (`scratch-git-2/src/cli/table_spec_cache_refresh.rs`)

- **Owned files:** exactly `schema.json` and `views/default.json`, at any depth under a connection's cache directory. Only git ever put them there, and Desktop never writes them. `validation.json`, non-default views, hidden files, and everything else are never touched.
- **Pure planner:** `plan_table_spec_cache_changes_for_connection(server_folders_for_connection, owned_local_files_with_sha256) -> TableSpecCachePlan { deletes, writes, unchanged, warnings, folder_keys_with_changed_table_spec_bytes }`. Rules:
  1. **Path validation.** Reject `..`, absolute paths, backslashes, NUL, and empty segments, following the `review_stats.rs:86` discipline. A rejected folder is warned about and skipped. Paths map like `files.rs:1041-1051`: `/` is the cache root, anything else is the path without its leading `/`.
  2. **`present`.** Write when the file is missing or its raw-byte hash differs (no CRLF normalization, because DEV-10518 hashes raw bytes). Equal bytes are left alone, so mtimes stay put and Desktop's watchers stay quiet.
  3. **`absent`.** Delete the owned file. **`unreadable` or `Unknown`:** keep the file and warn.
  4. **Prune.** Delete owned files whose directory no listed folder claims, for example an unlinked or moved folder. Remove `views/` and the folder directory only if they are empty, so `validation.json` keeps its directory. An orphaned `validation.json` is user content, so it stays (see [Risks](#risks-and-open-questions)).
  5. **Duplicate cache paths** (none in prod): compare case-folded, NFC-normalized paths, because macOS and Windows treat `/Posts` and `/posts` as one directory. The folder with the newest `storedRowUpdatedAt` wins, matching the index build (store `:476-489`), with a warning.
- **Listing fetcher seam.** The protocol takes the fetcher as a trait (`TableSpecListingFetcher`), with `ApiClient` as the production implementation. The crate has no HTTP mock (its dev-dependencies are `tempfile` and `tower`), so this is what makes the protocol testable.
- **Protocol:** `refresh_table_spec_caches_from_server(fetcher, workspace_dir, workbook_id, contexts, connector_account_filter) -> TableSpecCacheRefreshReport`.
  1. One `metadataOnly=true` call, scoped to `connectorAccountId` when there is one context, otherwise to the workbook.
  2. Plan each local context against it.
  3. If any plan has writes, make one content call with the same scope, then re-plan from that complete listing. Check every `content` against its `sha256`; a mismatch counts as unreadable.
  4. Apply deletes, then writes, with `atomic_json_state::write_bytes_to_file_atomically` (`atomic_json_state.rs:147`; the temp file is hidden, so loaders skip it). This runs under the workspace lock.
  5. Return the report, including the changed folder keys, so the caller can run `folder_index::reconcile_enforce_schema_results_after_schema_change`.
  - Steady state is one small metadata call. The worst case is two calls.
  - Folders whose connection has no local context are skipped.
- **Failure:** any failed call, including a 404 or a 429 after retries, leaves the cache untouched and sets `status: "failed"`. A `formatVersion` newer than the build gives `unsupported-format` and keeps the cache. There is no old-server fallback: MR 2 merges only after MR 1 is in prod, CLI and Desktop releases build from `prod`, and test builds come from `master`, so no shipped binary meets a server without the route.
- **New subcommand:** `scratchmd files refresh-table-specs [--connection <id|dir>] [--json]` runs the refresh by itself. That keeps the operation runnable and checkable in isolation, and it replaces the "repair on accept" side effect that goes away below.

**Wiring**

| Flow | Change |
| --- | --- |
| `files download` (`files.rs:801`) | After the per-connection fan-out (`:960-974`) and before `write_docs` (`:1005`), outside the `skip_folder_index` gate, refresh every non-error connection **in the workspace marker**, not only the cwd-filtered download contexts (fix 1 below). This runs on `up_to_date` pulls too: with the mirror off, a spec-only change makes no commit. It also fixes today's `--skip-folder-index` gap. Delete the syncs at `:1038-1040` and the `if master_update.moved { … }` block at `:6776-6782`, keeping the `update_main_worktree_after_pull` call at `:6775` (fix 2 below). Keep the DEV-10518 loop (`:1010-1066`) as is; it now hashes the REST-written bytes. |
| `workspaces init` (`workspaces.rs:329`) | Delete the sync block in `setup_connection` (`:853-862`). After `init_v2` returns and the workspace is registered (`config::workspaces::upsert`, `:387`), refresh all connections with a 60 s timeout. If the refresh fails, **exit 0** with a stderr warning that `scratchmd files download` finishes it, and `tableSpecCacheRefresh.status: "failed"` (fix 4 below). `init_v2` stays synchronous and HTTP-free, so its unit tests need no mock. |
| Linked refresh (`download_workbook`, `files.rs:4054`) | On every path out of `download_workbook` (the structure-version early return at `:4092`, the unreviewed-edits early return at `:4122-4146`, a failed connection download at `:4154`, and success), take the lock, refresh, and reconcile the changed folders (fix 3 below). Specs are server-owned, so unreviewed record edits don't block them. Delete the sync at `:4156`, keeping the `update_main_worktree_after_pull` call at `:4155`. |
| `files reconcile-after-publish` (`:6567`) | After `download_single_repo` (`:6616`) and before `reindex_folder_index_for_changes` (~`:6622-6630`), refresh `ctx.connection_id` and reconcile the changed folders. The publish-plan build can rewrite the spec (`schema-helper.service.ts:273-276`); today the full-tree materialize carries that change to disk. A new `--skip-table-spec-refresh` flag skips it (fix 5 below). |
| `files publish` (`:2180`) | Same, after `reconcile_accepted_after_publish`. |
| Review commands (`files.rs:3083`, `:3451`, `:3553`, `:3654`, `:7765`, `:7878`, `:7979`, `:8067`) | Delete the sync calls, the wrapper at `:433`, and `review_ops::sync_schema_files_from_worktree`. They only repaired a missing cache from a worktree copy that is never newer than the last pull. |

**Disconnecting git from the cache**

1. **`materialize_local_repo`:** `resolve_disk_path` (`files.rs:8194-8202`) returns `None` for every key that starts with `.scratch`. Full-tree mode then never writes or deletes cache files, so git can't overwrite REST-written specs. The server writes only `schema.json` and `views/*.json` under `.scratch/`, so nothing else depended on this path. This supersedes the narrower MR 0 rule.
2. **`files revert-plan`:** `load_id_column_remote_id_for_folder` (`:5486-5509`, called at `:2426`) reads `<cache>/<folder>/schema.json` first. While the mirror is on, it falls back to `main_map`. When it has to fall back to `DEFAULT_ID_PATH`, it prints a stderr warning that names the folder.
3. **Worktree `.scratch`:** leave the checkout (`files.rs:8857`) alone until DEV-13028. Once the syncs are gone, nothing reads it. DEV-13028 removes the checkout and does a one-time removal of the stale copies.
4. **Agent docs:** in `generate_docs.rs` (`:320-322`, `:372`, `:681`, `:703-715`), name only the cache path. Describe it as server-managed, refreshed on download, init, linked, and publish, and not for editing. Describe the worktree `.scratch` as a legacy git copy. Also update `docs/REPO_STRUCTURES.md` and `docs/PULL_AFTER_PUBLISH.md`.

**JSON output** (additive): `files download`, `files reconcile-after-publish`, and `files refresh-table-specs` gain:

```json
"tableSpecCacheRefresh": {
  "status": "refreshed",
  "schemaFilesWritten": 1,
  "defaultViewFilesWritten": 0,
  "filesDeleted": 0,
  "foldersWithChangedTableSpec": ["Airtable - Base/Table"],
  "foldersWithUnreadableServerSpec": [],
  "error": null
}
```

`status` is `refreshed`, `failed`, or `unsupported-format`. Desktop parses its output with `JSON.parse(...) as T` (`scratchmd.ts:1017`), so additive fields are safe.

**Offline and failure behavior**

| Situation | Behavior |
| --- | --- |
| Local commands (validators, `paginate-records`, `record-tree`, `syncs validate-local`, `validation *`, `revert-plan`) | Unchanged: they read the cache and work offline |
| `files download` or `init` with no network | Fails at `GET :id`, as today |
| Spec calls fail after retries while records pulled | Exit 0, stderr warning, `status: "failed"`, cache untouched; the next pull retries |
| `init` spec fetch fails | Workspace created and registered; exits 0 with a stderr warning naming the repair command, and `status: "failed"` (fix 4) |
| Listing succeeds, some folders `unreadable` | Those folders keep their local files; the rest refresh |

Nothing is ever deleted on a failed call. Deletes happen only on an `absent` status or a prune from a successful, complete listing.

### Wiring review fixes (2026-11-25)

A review of the CLI and Desktop wiring against `7c8ad12be` found these. The wiring table above already includes them.

1. **Gap: refresh every connection in the workspace marker.** `files download` rebuilds its contexts with the cwd filter (`files.rs:845`, `build_connection_contexts(..., Some(cwd))`). Run from inside `<ws>/<connA>/`, a connection B that `sync_workspace_structure` adds or repairs in the same run (`files.rs:1298`, `:1328`) would get no specs. Today `setup_connection` fills B's cache from its worktree, and that goes away. Repair is worse: it deletes B's whole cache first (`workspaces.rs:926`). Fix: refresh with `build_connection_contexts(..., None)`, minus connections that errored. It is still one workbook-scoped call. Desktop always runs from the workspace root, so this hits CLI users only.
2. **Keep the `update_main_worktree_after_pull` calls.** Its `reset --mixed` keeps the gix index right for detecting unreviewed edits, and its `changed_paths` feed the reindex (`files.rs:6783-6793`). Delete only the syncs.
3. **The linked refresh must not depend on the record download succeeding.** `refresh_workbook_for_contexts` stops at the first failing connection (`download_single_repo(...)?`, `files.rs:4154`). Today the connections before the failure still get their caches synced. A refresh chained after it with `?` would skip every connection.
4. **`init` must not exit non-zero after creating the workspace.** Desktop runs init without `--json` or `--force` and with stdin ignored (`scratchmd.ts:398`). After a non-zero exit, `HomePage.tsx:166-176` shows "Download failed". A retry finds the existing workspace, and the overwrite prompt (`workspaces.rs:363`) reads empty stdin, prints "Cancelled.", and exits 0 (`:369`). Desktop then opens a workspace with no specs, and focus-sync doesn't pull because the folder count didn't change (`WorkspacePage.tsx:628-638`). So init exits 0 with a warning, and the next `files download` (Desktop's hourly one included) repairs it. Run the refresh after `config::workspaces::upsert` (`workspaces.rs:387`) so the workspace is registered either way.
5. **Rate budget during a whole-workspace Desktop publish.** `PublishChangesModal.tsx:2056-2069` runs `reconcile-after-publish` for each published connection, then one workspace-wide `files download`, which refreshes every connection again. Each reconcile already makes 2 REST calls (`files.rs:6508`, `:6553`) and 2 or 3 git-proxy calls in the shared 60-per-minute bucket (`api-rate-limit.guard.ts:27`), and a 429 there fails the whole reconcile. Desktop passes `--skip-table-spec-refresh` in that loop only. The single-connection and single-table paths (`:1927`, `:1974`) keep the refresh, because they don't pull afterwards.
6. **Known behavior, documented rather than changed:**
   - `files reconcile-published` (Desktop's single-record publish, `PublishChangesModal.tsx:1881`) doesn't refresh specs. A spec rewritten by that plan build reaches the cache on the next download. Today it reaches it only through a later review command's sync.
   - Only `default` was ever mirrored to git (`writeViewToGit` has only ever been called with `'default'`), so the "owned files" rule loses nothing git delivered. But `sync_schema_files_from_worktree` copied every `views/*.json` from the worktree `.scratch` (`review_ops.rs:1222-1228`), and the agent docs describe that folder as holding view definitions (`generate_docs.rs:320`). A view someone adds there stops reaching Desktop, so the docs update must say to put named views in the cache folder.
   - `linked add` on a connection that isn't in the local marker gets no specs until a full `files download` (`download_workbook` doesn't run `sync_workspace_structure`). Records are skipped the same way today. The `linked add` test uses a connection that is already set up locally.
   - `--skip-folder-index` refreshes the spec bytes but leaves stale `enforce_schema` results until the next pull without the flag, because the DEV-10518 loop stays inside that gate (`files.rs:1010`). Nothing in the repo uses the flag.
   - `shared/index.rs:122-129` (`load_schema_maps`) reads the worktree `.scratch`, but its only caller, `build()`, has no callers. DEV-13028 removes it.

### MR 2 implementation notes

Where MR 2 differs from, or adds to, the design above:

- **Module:** `scratch-git-2/src/cli/commands/table_spec_cache_refresh.rs`. Claiming (`claim_cache_files_for_connection`) and planning (`plan_table_spec_cache_changes`) are separate pure steps; the I/O layer hashes the bytes the filesystem returns for each claimed path, so on macOS and Windows a case-only folder rename reads the existing file instead of rewriting it every refresh. Pruning keeps an owned file that differs from a claimed path only in case.
- **Duplicate paths** are resolved case-insensitively but not NFC-normalized: the crate has no Unicode-normalization dependency, and prod has no duplicate paths.
- **`files download`** refreshes every connection in the marker, including one whose record download failed, because specs don't depend on it.
- **`workspaces init`** exits 0 when the refresh fails (fix 4); the warning names `scratchmd files refresh-table-specs`.
- **`files publish`** refreshes the connections that published and reports problems on stderr only; its `--json` output is unchanged.
- **`files revert-plan`** warns only when no spec is readable anywhere (cache or git), once per folder.
- **Telemetry fields** are flat (`presentFileCount`, `absentFileCount`, `unreadableFileCount`) instead of `statusCounts`, so HogQL can filter on them; the DEV-13027 gate is `unreadableFileCount = 0`.
- **Verified mirror-off:** the full `scratch-cli-tests` suite and the new `table-specs` suite were run locally against a server with `TABLE_SPEC_GIT_MIRROR_ENABLED=false`.

### Desktop (`scratch-desktop`)

Required changes:

1. `scratchmdEnv()` (`src/main/scratchmd.ts:364`) sets `SCRATCH_DESKTOP_APP_VERSION = app.getVersion()` **before** the `!app.isPackaged` early return. This is the only way Desktop versions show up in CLI traffic, because the bundled binary reports 0.1.0.
2. The whole-workspace publish loop (`PublishChangesModal.tsx:2056-2069`) passes `--skip-table-spec-refresh` to `reconcile-after-publish`, because the `files download` after it refreshes every connection anyway (fix 5).
3. Ship the weekly prod release that bundles the new CLI, then raise `MINIMUM_SUPPORTED_DESKTOP_VERSION` to it.

What stays the same:

- `local-files.ts` readers, IPC channels and path policies, the watchers, and the e2e fixtures that seed the cache.
- No main-process HTTP is added. That avoids the `axios` packaging trap (`electron-builder.yml:40`), and it avoids a second writer racing the CLI.

What Desktop gains without code changes:

- custom validators survive publish and repair (from MR 0);
- spec reads are never torn;
- spec changes arrive on `up_to_date` pulls;
- review actions stop causing spurious hot-reloads (`FolderDataGrid.tsx:1051-1055`).

### Compatibility

| Binary and server state | Result |
| --- | --- |
| Old binary, mirror on (today) | Unchanged, including the `validation.json` bug unless it has MR 0 |
| Old binary, mirror off, copies kept | Specs frozen and stale. A folder linked later gets no spec: `record-tree` errors, `enforce_schema` does nothing, numbers sort as text, and `revert-plan` uses `id`. **Prevented by the gate.** |
| Old binary, copies deleted | The first publish empties its cache (without MR 0, `validation.json` too). **Prevented by the gate.** |
| Old Desktop locked by the minimum version but still running | Its main process keeps pulling hourly with the old CLI until restart. Harmless while copies exist; scoped pulls exclude `.scratch` after the delete. Counted as legacy traffic. |
| New binary, server without the route | Not shipped (MR 2 merges after MR 1 is in prod). A 404 reports `failed` and keeps the cache. |
| New binary, reads flag off | The endpoint ignores the reads flag and serves Postgres. While the mirror is on, git matches, so the server and the CLI agree. |
| New binary, mirror on, off, or copies deleted | Works. Git `.scratch` is ignored. |
| Old and new binaries on one workspace | The old full-tree materialize rewrites the cache from git: the same bytes while the mirror is on, stale bytes after the freeze. The new binary compares against server bytes, so it corrects the files on its next refresh. |
| First refresh where git bytes ≠ stored bytes | One rewrite and one `enforce_schema` clear for that folder. See [Risks](#risks-and-open-questions) for the size of this class and its user-visible effect. |

## Rollout and gates

0. **Step 0: decided 2026-11-25.** Build this design. The maintainer accepts that specs become server-owned rows with no server-side git history (local copies stay files; DEV-13028 edits CLAUDE.md). The CLI and Desktop sunset is on hold.

1. **MR 0: folded into MR 2** (see [MR 0](#mr-0-stop-deleting-custom-validators-folded-into-mr-2)).
2. **MR 1: server, shared-types, and Bruno.** Endpoint, store method, the divergence report byte check, client classification on `cli_list_workbooks`, the `cli_list_table_specs` event, the Bruno and skill UA changes, the stale comment fixes, and tests. This changes no client behavior.
   - Before merging, re-run the read-only divergence report and an import dry run on prod to reconfirm that Postgres still holds everything git has. You run these; prod needs your approval.
   - Confirm it is deployed, not just merged: `git merge-base --is-ancestor <sha> origin/prod` plus a Cloud Run revision in the audit logs.
   - Smoke-test the endpoint on test with Bruno.
3. **MR 2: CLI plus the Desktop env line.** Merge only after MR 1 is in prod.
   - Before merging, run the mirror-off suite locally (see [Test plan](#test-plan)).
   - Soak on the hourly `desktop-test` channel and run `/qa-desktop-app`.
4. **Weekly prod release** (Wednesday 10:00 PT) ships Desktop vX, the standalone CLI vY (GitHub, Homebrew, and Scoop), and the Desktop cask. Watch `cli_list_table_specs` volume, `unreadableFileCount`, and 429s on `/cli/v1`.
5. **Raise `MINIMUM_SUPPORTED_DESKTOP_VERSION` to vX** about one week after release. This is a production PostHog change and needs explicit approval. First check that Linux `.deb` installs auto-update (electron-updater 6.8 supports them, but this hasn't been tested here); if they don't, tell those users to install by hand.
6. **Measure.** Load balancer logs are independent of PostHog, which fails open; the sample rate is 1.0:

   ```
   gcloud logging read 'resource.type="http_load_balancer" AND httpRequest.requestUrl:"/cli/v1/" AND httpRequest.userAgent="Scratch-cli/1.0"' \
     --project=spv1eu-production --billing-project=spv1eu-production --freshness=30d \
     --format='csv(timestamp,httpRequest.remoteIp,httpRequest.status,httpRequest.requestUrl)'
   ```

   - **Attribution:** match legacy IPs against renderer UAs (`scratch-desktop/<ver>`) from the same IPs. That separates old Desktop processes that haven't restarted from standalone CLI holdouts.
   - **Adoption:** every user with `scratchmdClientKind = 'scratchmd'` events also has `cli_list_table_specs` events.
   - **Per-user holdouts (supplementary, undercounts):**

     ```sql
     SELECT distinct_id, max(timestamp) AS last_seen, count() AS requests
     FROM events
     WHERE event = 'cli_list_workbooks'
       AND properties.scratchmdClientKind = 'legacy-scratchmd'
       AND timestamp > now() - INTERVAL 30 DAY
     GROUP BY distinct_id ORDER BY last_seen DESC
     ```

7. **426 guard (the expected path).** Old Desktop processes and standalone binaries won't reach zero by themselves, so plan this now rather than as a contingency. About 7 days after step 5:
   - ship a server-only `RejectLegacyScratchmdGuard`. It goes after `ScratchAuthGuard` on every `cli/v1` controller except `cli-auth`. It checks the UA first and evaluates the per-user `UserFlag.REJECT_LEGACY_SCRATCHMD_CLIENTS` only for the exact legacy UA, then returns 426 with an upgrade message. Roll it out to internal users first, then 100%.
   - Old binaries print the error and don't retry. Every pull, upload, and publish path makes a REST call before touching git, so they are blocked before any harm. Plain `git clone` is unaffected.
   - The guard needs no client release. A maintainer can instead accept a named holdout list.
8. **DEV-13027 entry criteria.** All must hold:
   - Either the 426 guard has been at 100% for at least 7 days with zero non-426 legacy requests since then, or zero legacy-UA requests in the trailing 30 days (the DEV-12661 method), or a maintainer-approved holdout list.
   - The minimum Desktop version was raised at least 7 days earlier.
   - Over the trailing 14 days:
     - `cli_list_table_specs.unreadableFileCount = 0`;
     - `DATA_FOLDER_TABLE_SPEC_READ_FELL_BACK_TO_GIT` comes only from the known folders with no spec anywhere (the 20 classic folders, checked by folder id in the logs);
     - `SCRATCH_GIT_INDEX_BUILD_TABLE_SPECS_NOT_SENT` is 0;
     - `SCRATCH_GIT_INDEX_BUILD_READ_TABLE_SPEC_FROM_GIT` comes only from known lone-surrogate specs, bad keys, and no-spec folders. That reader is the scratch-git index build, not the CLI; DEV-13028 removes it.
   - DEV-13026 (web viewer) is done.
   - `TABLE_SPEC_POSTGRES_READS_ENABLED` is removed or locked on. With the mirror off, turning reads off would make the server read stale or missing git copies.
9. **DEV-13027: freeze, then delete.**
   - Set `TABLE_SPEC_GIT_MIRROR_ENABLED=false` and leave the copies for 7 to 14 days.
   - Rollback is re-enabling the mirror **and** running a new "re-mirror all rows" code migration. The mirror writes only on each folder's next write, so without the migration, folders changed during the freeze stay stale in git. DEV-13027 builds that migration before it turns the mirror off.
   - Then run the delete migration.
10. **DEV-13028.** On top of its server list, remove:
    - the `revert-plan` `main_map` fallback;
    - the worktree `.scratch` checkout (`files.rs:8857`), plus a one-time removal of stale worktree copies;
    - the CLAUDE.md principle wording, as agreed in step 0.

## Test plan

**Rust** (`cargo test --bin scratchmd`)

- `api/tests/mod.rs`:
  - metadata responses have no `content`;
  - all three statuses deserialize, and an unknown status maps to `Unknown`;
  - a folder with a missing `sha256` becomes unreadable while its siblings still parse;
  - content containing a trailing `\n`, multibyte text, and literal `\ud83d` escape text round-trips byte-exact;
  - the UA starts with `Scratch-cli/` and never equals the legacy constant.
- Planner (pure):
  - equal bytes do nothing; changed or missing files are written; CRLF-vs-LF on disk gets rewritten;
  - `absent` deletes; `unreadable` keeps;
  - prune removes only owned files and keeps `validation.json` and its directory;
  - moved folder, root `/` folder, and nested folders;
  - duplicate paths, including case-only and NFC/NFD differences, resolved by the newest `storedRowUpdatedAt`;
  - traversal and absolute paths rejected.
- Protocol, through a fake `TableSpecListingFetcher`:
  - verbatim bytes; a SHA mismatch is rejected; equal bytes keep the mtime; writes are atomic;
  - nothing is deleted after a failed call;
  - a 404 reports `failed` and keeps the cache;
  - a 429 after retries keeps the cache, and the next run converges;
  - the content call happens only when the metadata plan has writes, and at most once.
- `tests/files.rs:126`: invert it, so materialize no longer writes the cache. Add cases to the post-publish reconcile group (`:3772-4430`) showing that `validation.json`, `schema.json`, and `views/default.json` survive full-tree mode, and that `.scratch` keys don't change counts.
- Replace `tests/files.rs:235` and `tests/workspaces.rs:74`. Update `tests/workspaces.rs:123` so `init_v2` no longer fills the cache.
- `revert-plan`: a connector whose id root isn't `id`, with the schema only in the cache, still gets the recreate sentinel.
- DEV-10518: a refresh that changes bytes clears only that folder's `enforce_schema` rows; an identical refresh keeps the baseline.
- Ordering: in `reconcile-after-publish`, the refresh runs before `reindex_folder_index_for_changes`.

**scratch-cli-tests**

- New `table-specs.spec.ts`:
  - after `init`, cache bytes equal the endpoint `content` for the spec and the default view;
  - a server schema refresh followed by an `up_to_date` `files download` updates the cache and clears `enforce_schema`;
  - a `--skip-folder-index` pull still refreshes specs;
  - a publish whose plan build rewrites the spec, followed by `reconcile-after-publish`, updates the cache and clears `enforce_schema`;
  - `linked add` writes the new folder's spec, and unlink prunes it;
  - a custom `validation.json` survives `files publish` and `reconcile-after-publish` (regression test for the MR 0 bug);
  - `refresh-table-specs` repairs a deleted cache;
  - in `workspace-sync.spec.ts`, a connection added after init, then a `files download` run from inside another connection's directory, writes the new connection's `schema.json` (fix 1);
  - Desktop's whole-workspace publish passes `--skip-table-spec-refresh` and still ends with fresh specs from its final `files download` (fix 5).
- Tighten `api-workspace-setup.spec.ts:339-402` to compare bytes. Update the comments in `sync-empty-folder.spec.ts`.
- **Mirror-off proof:** before merging MR 2, run `table-specs`, `api-workspace-setup`, `record-tree`, `validators`, and `publish` locally against a server with `TABLE_SPEC_GIT_MIRROR_ENABLED=false`, including a folder linked after the mirror went off. DEV-13027 makes mirror-off the CI default.

**Server**

- Store method:
  - stored row, a row with a null view, and no row;
  - a non-object row is `unreadable`;
  - with the reads flag off, it still reads Postgres, and it never calls `ScratchGitService`;
  - `sha256` matches the UTF-8 bytes;
  - `metadataOnly` gives the same statuses without content;
  - a connection with no linked folders appears with an empty list.
- Controller (unit, `cli-table-specs.controller.spec.ts`): the guards are present; another user's workbook returns 404 before the store is read; scope and `metadataOnly` reach the store; the telemetry counts.
- Real Postgres (`data-folder-table-spec-db.spec.ts`): the connection set matches `GET :id`'s query, a folder with a null path is left out, the bytes and hashes match the stored row, and a `connectorAccountId` from another workbook returns 404.
- Divergence report: the byte check counts a `generatedAt`-only difference.
- A cross-language fixture that Node and Rust hash identically: `scratch-git-2/tests/fixtures/cli-workbook-table-specs-response.json` (multibyte text, lone-surrogate escape text, the trailing newline, and all three statuses). The server pins its wire output to it (`cli-workbook-table-specs-contract.spec.ts`); MR 2's Rust test deserializes it and checks its own hashes.
- Unit tests for the UA classification.

**Desktop**

- No fixture changes.
- A vitest test that `scratchmdEnv` sets the version in packaged and unpackaged builds.
- `/qa-desktop-app` against test:
  - download a workspace and check grid columns, title, FK labels, and the page tree;
  - link a table on the web, pull, and check that it appears with its view;
  - publish and confirm a custom validator survives.

## Risks and open questions

1. **A class of folders silently stops refreshing.** MR 2 removes the git writers in the same release that adds the REST writer. Mitigations: per-folder statuses, stderr warnings, `statusCounts` telemetry, the ordering and `--skip-folder-index` tests, and the mirror-off suite. MR 0 fixes the `validation.json` loss without touching the writes, so the early fix can't miss specs rewritten by a publish-plan build.
2. **One-time `enforce_schema` clears.** The first refresh rewrites every folder whose cache bytes differ from the stored bytes. That class is larger than shim imports: it includes every row first created by a pull, refresh, or publish-plan build, because git kept the older `generatedAt`. Each rewrite clears that folder's `enforce_schema` results, and nothing re-runs validation until the user opens the folder's grid (Desktop revalidates only newly seeded folders). Validation counts drop for those folders in the meantime. This is the same clear-only behavior as any spec change on today's pulls; it just happens to many folders at once. The divergence report byte check (MR 1) measures the class before MR 2 ships. If it's large, run `revalidate_folder` for `foldersWithChangedTableSpec` in the refresh flows.
3. **Payload size.** The worst case is about 4.7 MB raw (around 6 MB escaped, uncompressed) for one workbook's content call. It is sent only when something changed. The steady state is metadata only.
4. **Server cost per pull.** The metadata call reads every row's content in the workbook to hash it. It makes no git reads.
5. **Rate budget.** A refresh is one call, or two when something changed. It shares the per-user 60-per-minute bucket with the git proxy, which makes two or three requests per connection fetch. A pull of a workbook with many connections already spends much of that bucket on git. The refresh comes last, and a 429 after retries leaves the cache untouched and converges on the next run. If 429s show up on the endpoint, give it a lower weight with the existing `@ApiRateLimit` decorator, or honour `Retry-After` in the CLI.
6. **Standalone CLI users can't be forced to upgrade.** The answer is the measured gate plus the 426 guard.
7. **Old Desktop keeps running after the lock.** `MINIMUM_SUPPORTED_DESKTOP_VERSION` fails open and locks only the renderer. The hourly main-process pull keeps sending legacy traffic until restart. The 426 guard ends it; load balancer logs are the check that doesn't depend on PostHog.
8. **No repair on accept.** A user who deletes the cache needs `files download` or `refresh-table-specs`. The `record-tree` error already says "has the folder been pulled?".
9. **Orphaned `validation.json` files.** When a folder is unlinked or moved, the prune keeps its `validation.json` and directory, because custom validators are user content. Today the post-publish full-tree delete removes them by accident. Desktop's `getValidationConfigs` will list those dead folders. That's cosmetic; see Follow-ups.
10. **Open: freeze window.** DEV-13027 currently turns the mirror off and deletes the copies in one step. This design recommends freezing for 7 to 14 days first.

## Follow-ups

These are notes only. No Linear issues were filed.

- **Desktop:**
  - show a non-blocking notice when `tableSpecCacheRefresh.status` is `failed` or `unsupported-format`;
  - re-attach fleet-2 watchers for directories created after registration (`workspace-file-watch.ts:150-156`, `:195-205`);
  - invalidate the 30 s `getFolderReferenceInfos` cache on `scratch:connection-file-changed`;
  - surface a missing spec instead of By-field review's "No pending changes" (`ByTypeView.tsx:37-43`), which hides pending work;
  - have `getValidationConfigs` skip folders that are no longer linked.
- **Desktop freshness for spec changes made on the web:** add a per-folder spec hash to the workspace detail Desktop already refetches on focus, and run `refresh-table-specs` when it changes.
- **Desktop CI:** inject the release version into the bundled `scratchmd`'s `Cargo.toml` (`.gitlab-ci-release.yml:194-197`) so it stops reporting 0.1.0.
- **Git transport attribution:** add `X-Scratch-Client` through a second `http.extraHeader` (`git_ops/remote.rs:48-53`), so git-proxy traffic can be tied to a client version.
- **CLI retries:** honour `Retry-After` on 429 for every GET.
- **Endpoint cost:** stored hash columns (a migration the user applies) or Postgres-side hashing, and response compression (`compression` middleware plus reqwest `gzip`), if the cost shows up.
- **Existing server issues:** `GET /data-folder/:id/schema` turns read errors into 404 (`data-folder.service.ts:1160-1168`). `getLinkedTable` doesn't compare the folder's workbook with the URL (`cli-linked.controller.ts:151`).
- **Legacy cache contents:** publish-plan directories in the cache are dead and harmless. They could be cleaned up in DEV-13028.
