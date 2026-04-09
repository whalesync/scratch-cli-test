# Desktop: Refresh workspace after "Manage Connections" (web) — focus sync + `files download` resync

## Context

Scratch Desktop opens the web app for **Manage Connections** (`VITE_SCRATCH_WEB_URL` + `/workspace/{id}/connections`). Users add connector accounts and link data folders there, then return to the desktop app. The desktop must show new folders and stay consistent with server state.

This plan was written after an implemented solution hit merge conflicts; it has been **re-evaluated** so it matches the current `scratchmd` behavior: `files download` is no longer “marker-only” — it **reconciles local workspace structure with the server** before pulling git.

**Last reviewed**: 2026-04-08 against `scratch-git-2` `files.rs` (`run_download`, `sync_workspace_structure`) and `scratch-desktop`.

> **Branch note**: An earlier revision of this plan may already be implemented on your branch. Before re-applying or reviewing a PR, compare the tree to this document. The important change in this revision is treating **`scratchmd files download`** (via `scratch:pull-workspace-changes`) as the **primary** fix for stale local connection layout, and reserving **`workspaces init --force`** for **residual** “no connections” failures only.

---

## Problem

1. **Stale server state**: Workspace detail (`GET /workbook/:id`) is loaded once on mount. New `dataFolders` / connections from the web are invisible until a full remount or manual refresh.

2. **Stale local tree**: The sidebar lists folders via **`scratchFiles.listFolders(localPath)`** (disk only). Nothing rescans after returning from the browser.

3. **Local vs server connections**: Previously, `files download` built connection contexts **only** from the local `.scratch` marker, so a checkout initialized with **zero** connections could not pick up new server-side connections without re-running `workspaces init`.

   **Update (CLI)**: `scratchmd files download` now runs a **workspace structure sync** first: it fetches the workbook from the API, compares **local marker connection IDs** to **`connector_accounts` on the server**, **adds** new connections (clone/setup), and **removes or detaches** connections the server no longer has (see `--on-delete`). It then rewrites the marker and proceeds with per-connection git download/merge.

   The **`workspaces init --force`** path is a **fallback** for cases where sync/download still leaves **no** usable connections (e.g. all new setups failed, or other edge cases), not the default fix for “I added a connection on the web.”

4. **SWR**: Desktop `App.tsx` uses `SWRConfig` with `revalidateOnFocus: false`, so there is no automatic HTTP revalidation on focus.

---

## Goals

- When the desktop window **regains focus** while viewing a downloaded workspace, **refetch** workbook detail from the API (without flashing the full-page loader).
- If a **local path** exists, run **`files download`** (`pullWorkspaceChanges` IPC) so the CLI **syncs connection layout with the server** and **pulls** git-backed folders.
- **Rescan** the folder list on disk after sync (bump existing `dataRefreshKey`).
- If download still fails with the **“no connections”** class of error **and** the server reports **at least one** connector/data-folder situation that implies connections should exist, run **`workspaces init --force`** from the workspace **parent** directory, then **`files download`** again (best-effort).
- Avoid running aggressive sync in the first ~1.5s after navigating to the workspace (skip duplicate work with the initial load).

---

## CLI reference (`scratch-git-2`)

| Behavior | Location / command |
| -------- | ------------------ |
| **Structure sync before pull** | `files.rs` — `run_download` calls `sync_workspace_structure` then re-reads the marker and `build_connection_contexts` |
| Compare local vs server | `sync_workspace_structure`: local marker `connections` IDs vs workbook `connector_accounts` IDs |
| Add new connections | `setup_connection` for each server-only account; `rewrite_connections` updates `.scratch` |
| Remove server-deleted connections | `teardown_connection` or `detach_connection` depending on `--on-delete` |
| “No connections” bail | After sync, if contexts are still empty **and** the sync phase reported **no** added/removed/detached changes — message still: `No connections found in {path}. Run scratchmd workspaces init first.` |
| `workspaces init <id>` | `workspaces.rs` — writes marker + clones connector repos |
| Re-init over existing tree | `workspaces init <id> --force` removes existing dir under the output parent and re-runs init |
| Init uses **cwd** as output parent | Desktop spawns `scratchmd` with `cwd` = parent folder containing the named workspace directory |

### `files download` flags relevant to desktop

- `--on-delete <prompt|remove|keep>` (default: `prompt`): what to do when a connection disappeared from the server. **Non-interactive** Electron spawns use `stdio: ['ignore', ...]` for `files download` — verify behavior for your CLI version (empty stdin vs JSON mode). If prompts are problematic, the IPC layer may need to pass e.g. `--on-delete keep` or `--on-delete remove` explicitly for headless runs.
- `--json`: in JSON mode, `prompt` is treated as `keep` when a connection was removed (see `files.rs`).

**Important**: `--force` on **`workspaces init`** still **deletes the existing local workspace directory** and reclones. Keep it **only** for the narrow fallback above; routine “return from Manage Connections” should be satisfied by **`files download`** structure sync.

---

## Current state (as of 2026-04-08)

### Already implemented

- **`dataRefreshKey`** exists in `WorkspacePage.tsx` with `handleDataRefresh()` callback. `WorkspaceContent` already accepts it as a prop and includes it in its `useEffect` dependency array for `listFolders`. The focus handler should call the existing `handleDataRefresh()` after pull.

### Verify on your branch

The following were called out in the original plan; **confirm** whether they already exist before duplicating work:

- Window **`focus`** listener on the workspace route (silent refetch + pull + `handleDataRefresh`).
- **`fetchWorkspace({ silent: true })`** (or equivalent) so focus does not toggle the full-page loader.
- **`scratch:init-workspace`** with optional **`force`** for the fallback path.
- **`parentDirectoryPath`** helper for the init cwd.

---

## Desktop implementation

### 1. `loadWorkspace` with silent mode

- Extend `fetchWorkspace()` in `WorkspacePage.tsx` to accept `{ silent?: boolean }`.
- **Non-silent** (initial navigation): set loading/error flags as today.
- **Silent** (focus path): update `workspace` / `localPath` state only; do **not** toggle the full-page loading UI.
- Return a small snapshot for the focus handler, e.g. `{ localPath: string | null; serverDataFolderCount: number }` where `serverDataFolderCount = data.dataFolders?.length ?? 0` (or use connector count from the API if you prefer parity with the CLI).

### 2. Window `focus` listener (workspace route only)

- Register on `window` `focus`; cleanup on unmount.
- Ignore events within **~1500 ms** of mount / `id` change (ref updated in the same `useEffect` that runs initial `fetchWorkspace`).
- Flow:
  1. `await fetchWorkspace({ silent: true })`; if no `localPath`, stop (nothing to pull on disk).
  2. **`await pullWorkspaceChanges(localPath)`** — this invokes **`scratchmd files download`**, which **syncs** local connection layout with the server **then** pulls. This is the main remediation for stale local state after web-side connection changes.
  3. If error matches **no-connections** (see below) **and** the server snapshot suggests connections should exist (`serverDataFolderCount > 0` or stricter matching):
     - `parentDir = parentDirectoryPath(localPath)`.
     - `await initWorkspace(workbookId, parentDir, { force: true })`
     - `await pullWorkspaceChanges(localPath)` again (best-effort).
  4. Call **`handleDataRefresh()`** to bump `dataRefreshKey`, which triggers the sidebar to re-run `listFolders`.

**Error matching**: Match the CLI stderr substring `no connections found` (case-insensitive). Verify against `files.rs` if messages change.

### 3. Folder list refresh

**Already implemented.** `WorkspaceContent` uses `dataRefreshKey` in its `useEffect` dependency array for `listFolders`. Calling `handleDataRefresh()` after pull is sufficient.

### 4. Parent path helper

- Add **`parentDirectoryPath(workspaceRoot: string)`** in `scratch-desktop/src/renderer/src/lib/parent-path.ts` (POSIX + Windows): strip trailing separators, remove last segment. Used as the **output parent** for `workspaces init` (same convention as first-time download: process `cwd` = parent, CLI creates/joins `{parent}/{workbookName}`).

### 5. IPC / preload: `initWorkspace` + `--force` (fallback only)

- Extend `scratch:init-workspace` handler in `main/index.ts` to accept an optional `{ force?: boolean }`.
- When `force` is true, append `--force` to the `scratchmd` args after `workspaces init <workbookId>`.
- Thread through preload and `ScratchDesktopAPI` typings.

**Optional follow-up**: extend `scratch:pull-workspace-changes` (or document CLI args) if you need to pass **`--on-delete`** for predictable non-interactive behavior.

**Current signature** (example):

```typescript
ipcMain.handle(
  'scratch:init-workspace',
  async (_, workbookId: string, cwd: string) => runScratchmd(['workspaces', 'init', workbookId], cwd),
);
```

**Target signature**:

```typescript
ipcMain.handle(
  'scratch:init-workspace',
  async (_, workbookId: string, cwd: string, opts?: { force?: boolean }) =>
    runScratchmd(
      ['workspaces', 'init', workbookId, ...(opts?.force ? ['--force'] : [])],
      cwd,
    ),
);
```

### Files to modify

| File | Change |
| ---- | ------ |
| `scratch-desktop/src/renderer/src/pages/WorkspacePage.tsx` | Silent `fetchWorkspace`, focus listener, pull via **`pullWorkspaceChanges`**; `--force` init only on residual no-connections |
| `scratch-desktop/src/renderer/src/lib/parent-path.ts` | **New file** — `parentDirectoryPath()` helper (if not present) |
| `scratch-desktop/src/main/index.ts` | `force` option on `scratch:init-workspace`; optionally `files download` extra args later |
| `scratch-desktop/src/preload/index.ts` | `force` param on `initWorkspace()` |
| `scratch-desktop/src/preload/index.d.ts` | Update `ScratchDesktopAPI` for `initWorkspace()` |

**Not modified** (unless you add IPC for `--on-delete`):

- `WorkspaceContent.tsx` / `WorkspaceSidebar.tsx` — unchanged aside from benefiting from `dataRefreshKey` updates.

---

## Edge cases and follow-ups

| Topic | Note |
| ----- | ---- |
| **Destructive `--force`** | Only for the no-connections + server-has-folders fallback. Not for normal “added a connection on the web” — **`files download`** should handle that. |
| **Second connection when one exists locally** | Covered by **`files download`** structure sync (`sync_workspace_structure` + setup for new IDs). |
| **Removed connections** | CLI can remove, detach, or prompt per `--on-delete`. Desktop may want an explicit policy via IPC flags. |
| **Home / workspace list** | `useWorkspaces` may still be stale until navigation; optional separate focus refresh for `HomePage` / switcher. |
| **Visibility vs focus** | This plan uses `window` `focus` (consistent with `AuthProvider` token check). `document.visibilitychange` is an alternative. |
| **Docs** | Optionally update `scratch-desktop/docs/ipc-api.md` for `init-workspace` + `force`, and note that `pull-workspace-changes` runs structure sync + download. |

---

## Verification checklist

- [ ] Download workspace with **no** connections → add connection + table on web → return to desktop → focus → **`files download`** syncs new connection; folders appear (**without** `--force` in the common case).
- [ ] Remove a connection on the web → focus → local layout matches policy (`--on-delete` / stdin behavior); sidebar updates after `handleDataRefresh`.
- [ ] Download workspace **with** connections → add another table on web → focus → new folder after **`files download`**.
- [ ] Residual failure path: if pull still reports no connections while server has data, **`workspaces init --force`** + second pull (dangerous; only this path).
- [ ] No local download (`localPath` null) → focus only refetches API; no `scratchmd` pull/init errors.
- [ ] `yarn lint` and `yarn build` in `scratch-desktop/`.

---

## Related code pointers

- Desktop "Manage Connections" link: `scratch-desktop/src/renderer/src/pages/workspace/WorkspaceSidebar.tsx`
- Pull IPC: `scratch:pull-workspace-changes` → `scratchmd files download` (structure sync + per-repo pull) — `scratch-desktop/src/main/index.ts`, `scratch-desktop/src/main/scratchmd.ts`
- Init IPC: `scratch:init-workspace` → `scratchmd workspaces init`
- CLI structure sync: `scratch-git-2/src/cli/commands/files.rs` — `run_download`, `sync_workspace_structure`
- Data refresh: `WorkspacePage.tsx` → `dataRefreshKey` + `handleDataRefresh()`
- Folder list effect: `WorkspaceContent.tsx` → `useEffect` keyed on `[localPath, dataRefreshKey]`
