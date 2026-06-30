# Connector-scoped publishing in the desktop app

- **Status:** Planned
- **Created:** 2026-06-30
- **Author:** Chris Hoefgen
- **Linear:** [DEV-10596 — Support connector scoped publishing in the desktop app](https://linear.app/whalesync/issue/DEV-10596/support-connector-scoped-publishing-in-the-desktop-app) (XS)

## Problem

Today the Scratch Desktop app can only publish the **entire workspace** ("Publish all" in the header). Users want to publish the approved changes for **just one connector** without touching the others. The ask: a right-click context-menu item on a connector node in the FolderTree — "Publish &lt;connector&gt;" — that publishes only that connector's changes.

## Why this is mostly UI work

The desktop already publishes **per-connection**: `PublishChangesModal` fans out `planJob`/`runJob` (each scoped to one `connectorAccountId`) in parallel across connections. A fully-built **single-record-scoped** mode (`singleRecord` prop, DEV-10413) already exists and is the exact precedent to mirror one level up (connector instead of record).

What is already connector-scopeable (no change needed):
- **Server** plan/run endpoints (`/publish-v2/plan-job`, `/run-job`) require `connectorAccountId` and accept optional `folderPath`/`filePath`. **No server MR needed.**
- **CLI** `files reconcile-after-publish --connection <id>` (matches `connection_id` **or** `conn_dir_name` — `files.rs:5279`).

What is **not** connector-scopeable today (the one gap we close):
- **CLI** `files upload`: either workspace-wide (a two-pass dirty gate that **aborts atomically** — `files.rs:1235-1246` `bail!`s and stages nothing if *any* connection is `blocked_dirty`/`check_failed`) or single-record (`--file-path`). There is no `files upload --connection`.

## Key decisions (confirmed with the requester)

1. **Full isolation** — add a `files upload --connection <id>` CLI flag so the chosen connector publishes regardless of other connectors' server state. (The alternative — reuse the workspace-wide upload and scope only plan/run/reconcile — was rejected because another connector being `blocked_dirty`/`blocked_stale` would block the chosen connector at upload.)
2. **Review-first block for unreviewed edits** — when the chosen connector has unreviewed local edits, the modal blocks with "review them first" + **Cancel only**. It must **never** run the workspace-wide accept-all/discard-all, which would mutate *other* connectors' edits (a "keep the user in control of what gets published" violation). Note: `files accept-all`/`reject-all`/`discard-all` already accept a `--folder` scope, so a future enhancement could offer scoped accept/discard — out of scope here.

## Single MR, no server dependency

The `scratchmd` binary is **bundled with the desktop app** (dev resolves `scratch-git-2/target/debug/scratchmd` via `getScratchmdBinaryPath`; packaged ships it in `Resources/bin/`). So the CLI change rides with the desktop release — there is no deployed-server dependency and this is a **single desktop+CLI MR**. (This satisfies the repo rule about splitting server vs desktop MRs: there is no server change.)

## Design — mirror the `singleRecord` precedent

Add a `singleConnection?: { connectionId; connectionName }` mode to `PublishChangesModal`, thread an `onRequestPublishConnector` callback down the FolderTree path, and add the context-menu item. Behavior per phase when `singleConnection` is set:

| Phase | Workspace-wide (today) | `singleConnection` (new) |
| --- | --- | --- |
| Pre-flight unreviewed | `listUnreviewedChanges` (whole workspace) → accept-all/discard-all | Filter to `connectionName`; if any → **review-first block, Cancel only** |
| Pre-flight validation | All folders; errors gate | Filter stats to `s.connection === connectionName`; only that connector's errors gate (respect `validateEnabled`) |
| Upload | `uploadWorkspaceChanges(path)` (all connections) | `uploadWorkspaceChanges(path, { connectionId })` (scoped via new flag) |
| Plan/Run | Fan out per connection-with-diff | One `ConnectionPublishState`; `runConnectionPublish` with `expectedBaseDirtyHead` from this connection's `uploadResult.dirtyHead`; **no `filePath`** |
| Reconcile | Per-connection `reconcileAfterPublish` + workspace-wide `pullWorkspaceChanges` | Scoped `reconcileAfterPublish(connectionId)`; **skip** the workspace pull (it refuses on other connectors' unreviewed edits) |
| Complete/error copy | Workspace wording | Connector wording; `plan-no-diff` → "nothing new to publish for this connection" |

## Changes by layer

### 1. CLI — `scratch-git-2/src/cli/commands/files.rs` (bundled with desktop)
- `Upload` command struct (≈line 176): add `#[arg(long = "connection")] connection: Option<String>` (doc: "connector account id or connection dir name").
- Command dispatch (≈line 603-606): pass `connection` into `run_upload`.
- `run_upload(...)` (line 1163): add `connection: Option<String>`. After `resolve_workspace_and_connections`, before the two-pass loop:
  - If both `connection` and `file_path` are `Some` → `bail!` (mutually exclusive; `--file-path` already implies one connection).
  - If `connection` is `Some`: filter `contexts` to the single match using the **existing convention** (mirror `files.rs:5279`): `c.connection_id == connection || c.conn_dir_name == connection`; `bail!` with a clear message if no match.
  - Run the **existing** two-pass dirty-gate + apply loop over the filtered single-element `contexts` (the `contexts.len() > 1` verbose guards already no-op for one). No new code path — just a narrowed `contexts`.
- `cargo fmt`; `cargo test`.

### 2. CLI tests — `scratch-cli-tests/tests/publish.spec.ts`
- `scratchmd files upload --connection <id>` stages only the named connection's accepted changes; other connections untouched; `--json` result carries the per-connection success shape for just that connection.
- **Isolation case:** with another connection in a `blocked_dirty`/stale state, the scoped upload still succeeds for the target connection.
- **Mutual-exclusion case:** `--connection` + `--file-path` together is rejected.

### 3. Desktop main/preload — thread the `connectionId` upload option
- `src/main/scratchmd.ts` `uploadWorkspaceChanges` (line 833): widen `opts` to `{ filePath?: string; connectionId?: string }`; push `--connection <connectionId>` when set (guard against passing both `filePath` and `connectionId`).
- `src/main/index.ts` IPC `scratch:upload-workspace-changes` (line 894): widen the `opts` type to include `connectionId`.
- `src/preload/index.ts` (line 173) + `src/preload/index.d.ts` (line 130): widen the `uploadWorkspaceChanges` signature to `{ filePath?: string; connectionId?: string }`.

### 4. Desktop renderer — new pure helper + tests
- **NEW** `src/renderer/src/pages/workspace/single-connection-publish-target.ts`: export `SingleConnectionPublishTarget` (`{ connectionId: string; connectionName: string }`) and a pure `resolveSingleConnectionPublishTarget(connectionFolders: DataFolder[])` returning `{ ok: true; target } | { ok: false; error }`, **null-guarding** `connectorAccountId`. (Sibling-file keeps `react-refresh/only-export-components` happy — see desktop CLAUDE.md.)
- **NEW** `src/renderer/src/pages/workspace/__tests__/single-connection-publish-target.spec.ts` (mirror `single-record-publish-target.spec.ts`): resolves from a valid `connectorAccountId`; `ok:false` on null/empty id; `ok:false` on empty folder list.

### 5. Desktop renderer — `PublishChangesModal.tsx`
- Add `singleConnection?: SingleConnectionPublishTarget` prop (document mutual exclusivity with `singleRecord`; if both set, prefer `singleRecord` defensively).
- `loadInitialState` (717): add a `loadSingleConnectionInitialState` branch before the workspace path (scoped unreviewed → review-first block; scoped validation; `validateEnabled`-aware), early-return.
- `startUpload` (568): when `singleConnection`, pass `{ connectionId }`; scope the success/summary copy to the one connection.
- `triggerPublish` (1157): add `triggerSingleConnectionPublish` (one `ConnectionPublishState`; connection-filtered pre-publish unreviewed re-check; `expectedBaseDirtyHead` from the connection's `uploadResult.dirtyHead`; no `filePath`).
- Terminal effect (1391): add `finishSingleConnectionPublish` (scoped `reconcileAfterPublish`; **skip** workspace pull; `invalidateWorkspaceLevelData`; `trackPublishCompleted`; complete/error; `singleConnectionNotice` for `plan-no-diff`).
- Three-way UI copy (`singleConnection ? … : singleRecord ? … : …`) in `approval` (review-first + Cancel only), `uploaded`, `complete`.

### 6. Desktop renderer — FolderTree context menu + wiring
- `FolderTree.tsx`: add `onRequestPublishConnector?: (p: { connectionId: string; connectionName: string }) => void` to `FolderTreeNodeProps` (≈161) and the top-level `FolderTreeProps` (≈588); thread it through (`FolderTree` → `FolderTreeNodeRow`, add to dep arrays). In `showContextMenu` `depth === 0` branch (218-239), compute `connectionId = connectionFolders[0]?.connectorAccountId` and push `{ id: 'publish-connector', label: \`Publish ${node.name}\` }` **only when `connectionId` is truthy**; in the callback (275-329) handle `'publish-connector'` → `onRequestPublishConnector?.({ connectionId, connectionName: node.name })`.
- `WorkspaceContent.tsx` + `WorkspaceSidebar.tsx`: add and forward `onRequestPublishConnector`, mirroring the `onRequestFolderPull` path (WorkspaceContent prop → WorkspaceSidebar line 182 → FolderTree).

### 7. Desktop renderer — `WorkspacePage.tsx`
- Add `singleConnectionPublish` state. Add `handlePublishConnector({ connectionId, connectionName })`: `trackPublishConnector(workspace.id, connectionId)`, `setSingleRecordPublish(null)`, `setSingleConnectionPublish(target)`, `setPublishModalOpen(true)`.
- Pass `singleConnection={singleConnectionPublish ?? undefined}` to `<PublishChangesModal>`; **clear `singleConnectionPublish` in every modal-close / `onPublishAll` / `onViewProblems` handler** (mirror how `singleRecordPublish` is cleared at lines 815/825/877).
- Pass `onRequestPublishConnector={handlePublishConnector}` down through `WorkspaceContent`.
- Gate the header spinner: `publishingAll={publishModalOpen && !singleRecordPublish && !singleConnectionPublish}` so a scoped publish doesn't spin the workspace-wide "Publish all" affordance.

### 8. Analytics — `src/renderer/src/lib/posthog.ts`
- Add `PUBLISH_CONNECTOR = 'publish_connector'` to `PostHogEvents` and `trackPublishConnector(workspaceId, connectionId)`, mirroring `trackPublishSingleRecord` (line 171). No tokens/credentials in context.

## Risks

- **Bundled-binary drift.** The new `--connection` flag lives in `scratchmd`, which the desktop bundles. If the renderer ships the `--connection` arg but the bundled binary is stale (not rebuilt), `files upload` will error on an unknown flag. **Mitigation:** the CLI + renderer land in the same MR; verify the packaged build rebuilds the binary (`scripts/build_mac_prod_local.sh` does `cargo zigbuild --bin scratchmd`), and for dev confirm `cargo build --bin scratchmd` was run (dev path is `scratch-git-2/target/debug/scratchmd`).
- **Two `--connection` semantics must agree.** `reconcile-after-publish --connection` and the new `upload --connection` both accept *either* connector-account-id or dir-name. The renderer passes the **connector account id** (`DataFolder.connectorAccountId`) for both. Keep them consistent; a mismatch (e.g. passing dir-name to one and id to the other) silently scopes to the wrong/no connection.
- **CLI integration suite.** Changing `files upload` flags/`--json` shape can break `scratch-cli-tests`. Update/extend `publish.spec.ts` rather than skipping (see scratch-git-2 CLAUDE.md).
- **`react-refresh/only-export-components` lint.** Any new exported helper must live in the sibling `.ts`, not in `PublishChangesModal.tsx` (which exports a component). Keep in-modal logic non-exported.
- **Shared-types lint false positives.** Run `yarn build` for `@spinner/shared-types` before `yarn lint` (the desktop pre-lint hook does this; see desktop CLAUDE.md) to avoid a wall of `no-unsafe-*` errors.
- **Scope creep into the unreviewed flow.** The review-first block is intentionally minimal. Resist wiring workspace-wide accept-all/discard-all into connector mode — it mutates other connectors. A scoped accept/discard is a separate follow-up.

## Edge cases

- **Null `connectorAccountId`** on a `DataFolder`: do **not** render the "Publish &lt;connector&gt;" menu item; `resolveSingleConnectionPublishTarget` returns `ok:false`. (Connector nodes normally have it, but guard anyway.)
- **Connector with no diffs:** scoped plan returns no pipeline → `plan-no-diff` → `complete` with a connector-aware notice. If the scoped **upload** itself returns `no_changes`/`up_to_date` (nothing accepted for this connector), route straight to `complete` with connector copy (mirror line 668).
- **Chosen connector unreviewed, but clean elsewhere:** review-first block fires only for the chosen connector; other connectors' unreviewed edits are irrelevant and must not gate (this is the whole point vs. workspace-wide).
- **Another connector blocked_dirty/stale:** with the scoped upload the chosen connector publishes regardless — this is the isolation win. Add a QA case for it.
- **`singleRecord` vs `singleConnection` mutual exclusivity:** the caller clears the other before opening; the modal prefers `singleRecord` if both are somehow set. Add a code comment + dev guard.
- **`autoStartUploadOnOpen` / `assumeUnreviewedApproved`:** not wired for connector mode — it runs its own pre-flight and early-returns, like single-record (return before the `autoStartUploadOnOpen` branch at line 818).
- **TOCTOU between upload and publish:** keep passing `expectedBaseDirtyHead` (the connector's post-upload `dirtyHead`) into `planJob`; the existing drift → `dirty` redirect still applies, scoped to the one connection. Don't pass `null` (single-record passes `null` only because its `filePath` plan-scope is the over-publish guard; a connector publish has no `filePath`, so the dirty-head token is the guard).
- **Post-publish refresh:** only the scoped `reconcileAfterPublish` runs; call `invalidateWorkspaceLevelData()` so the grid/validation/review counts refresh for that connector. Skipping the workspace pull is deliberate (it can refuse on unrelated unreviewed edits).

## Verification

- **CLI:** `cd scratch-git-2 && cargo build --bin scratchmd && cargo test && cargo fmt`. (Dev desktop auto-uses `target/debug/scratchmd` — no copy needed.) Run the new `scratch-cli-tests` upload case against a running server.
- **Desktop:** from `scratch-desktop/` run `yarn build`, `yarn lint`, and vitest (incl. new `single-connection-publish-target.spec.ts`).
- **Real-UI QA (required for client changes — desktop CLAUDE.md):** `/qa-desktop-app` against the live test backend with a workspace that has ≥2 connectors each with approved changes. Right-click one connector → "Publish &lt;connector&gt;"; confirm only that connector's records dispatch and the other stays approved-but-unpublished; confirm a connector with unreviewed edits shows the review-first block; confirm the isolation case (another connector dirty/stale, target still publishes).

## Follow-ups (out of scope)

- Per-connection scoped Accept/Discard in connector mode (using the existing `files accept-all --folder` / `reject-all --folder` scoping), to replace the review-first block with the same accept/discard convenience the workspace flow has.
