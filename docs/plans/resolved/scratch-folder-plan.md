# `.scratch` Folder Plan

Migrate schema storage from per-folder `.schema.json` dotfiles to a top-level `.scratch/` directory
inside each connection git repo. This gives us a clean, centralized location for server-managed
metadata that is visible to users but read-only from the CLI.

---

## Part 1 — Server: Schema Storage Migration

**File**: `server/src/scratch-git/scratch-git.service.ts`

### Constants (~line 23)

```ts
// Keep old name for fallback reads during migration
const LEGACY_SCHEMA_JSON_FILENAME = ".schema.json";

// New location
export const SCRATCH_DIR = ".scratch";
export const SCHEMA_FILENAME = "schema.json";
```

### `writeSchemaToGit` (~line 261)

```ts
// Old: folderPath.replace(/^\//, '') + '/' + SCHEMA_JSON_FILENAME
// New:
const normalizedFolder = folderPath.replace(/^\//, "");
const gitPath = `${SCRATCH_DIR}/${normalizedFolder}/${SCHEMA_FILENAME}`;
```

### `readSchemaFromGit` (~line 283) — add fallback

```ts
const normalizedFolder = folderPath.replace(/^\//, "");
const newGitPath = `${SCRATCH_DIR}/${normalizedFolder}/${SCHEMA_FILENAME}`;
const legacyGitPath = `${normalizedFolder}/${LEGACY_SCHEMA_JSON_FILENAME}`;

const file =
  (await this.getRepoFile(repoId, MAIN_BRANCH, newGitPath)) ??
  (await this.getRepoFile(repoId, MAIN_BRANCH, legacyGitPath));
if (!file) return null;
```

No other server files need to change — all callers go through these two methods.

### Migration note

Old `.schema.json` files remain in existing git repos and continue to be read via the fallback.
They can be cleaned up in a later migration once all repos have been written with the new path.

---

## Part 2 — CLI: Asymmetric `.scratch/` Handling

**File**: `scratch-cli/internal/cmd/files.go`

The goal: `.scratch/` is **downloaded** to disk (read-only reference for the user) but **never pushed** back up.

### `diskToFileMap()` (~line 1066) — allow `.scratch/` through

Replace the blanket dotdir skip:

```go
// Before:
if strings.HasPrefix(name, ".") || info.IsDir() {
    return nil
}

// After:
if info.IsDir() {
    switch name {
    case ".git":
        return filepath.SkipDir
    case ".scratch":
        return nil // descend into .scratch so merge engine sees server files
    default:
        if strings.HasPrefix(name, ".") {
            return filepath.SkipDir
        }
    }
    return nil
}
// Skip individual dotfiles (e.g. .schema.json, .scratchmd, .DS_Store).
// Files inside .scratch/ are named schema.json (no dot prefix) so they pass through.
if strings.HasPrefix(name, ".") {
    return nil
}
```

### `uploadSingleRepo()` — strip `.scratch/` before staging

After `mergedMap` is built (after the actions loop, ~line 664), before the `fileMapEqual` check:

```go
// Strip .scratch/ — server-managed, never pushed by the CLI.
for p := range mergedMap {
    if strings.HasPrefix(p, ".scratch/") {
        delete(mergedMap, p)
    }
}
```

Also guard the disk-cleanup loop (~line 714) so `.scratch/` files are never deleted from disk:

```go
for relPath := range remoteMap {
    if strings.HasPrefix(relPath, ".scratch/") {
        continue // never delete server-managed schema files from disk
    }
    if _, inMerged := mergedMap[relPath]; !inMerged {
        fullPath := filepath.Join(repoDir, filepath.FromSlash(relPath))
        _ = os.Remove(fullPath)
    }
}
```

### Download

No changes needed. `treeToFileMap` already reads all git tree files including `.scratch/`.
The merge engine emits `ActionWriteRemote` and writes `.scratch/schema.json` to disk.

### Old `.schema.json` files on disk

No filtering change needed — existing dotfile skip in `diskToFileMap` already excludes them from
upload. They remain on disk but are never pushed. No new logic required.

### Rollout risk

Between server deploy and CLI deploy, old CLI builds will see `.scratch/schema.json` in the remote
tree but skip the whole `.scratch/` dir in `diskToFileMap`, generating `ActionDelete` and deleting
schemas from git. **Keep this window short** — deploy CLI immediately after server.

---

## Part 3 — Client: Connection-Level "Show Hidden Files" + `.scratch` Folder Visibility

### 3a. Move "Show hidden files" to the connection level

**`client/src/stores/workbook-ui-store.ts`**

- Change `hiddenFileFolders: Set<string>` (keyed by `DataFolderId`) →
  `showHiddenConnections: Set<string>` (keyed by `connectorAccountId`)
- Rename `toggleHiddenFiles(folderId)` → `toggleHiddenFiles(connectorAccountId)`
- Update Zustand `persist` serialization key accordingly
- Existing localStorage state will reset to empty on upgrade (acceptable — default is hidden)

**`client/src/app/workbook/[id]/components/Sidebar/TreeNode.tsx`**

In `TableNode` (~lines 755-778):

- Remove `hiddenFileFolders` / `toggleHiddenFiles` store reads
- Remove the "Show hidden files" context menu item (~lines 1068-1075)
- Add `showHidden: boolean` prop to `TableNodeProps`

In `ConnectionNode` (~line 245):

- Read `showHiddenConnections` and `toggleHiddenFiles` from store
- Compute: `const showHidden = connectorAccount ? showHiddenConnections.has(connectorAccount.id) : false`
- Thread `showHidden` through `FolderTreeRenderer` → `TableNode`
- Add to `ConnectionNode` context menu (after existing items, only when `connectorAccount` is defined):
  ```tsx
  {
    label: showHidden ? 'Hide hidden files' : 'Show hidden files',
    icon: showHidden ? EyeOffIcon : EyeIcon,
    onClick: () => {
      if (connectorAccount) toggleHiddenFiles(connectorAccount.id);
      setContextMenu(null);
    },
  }
  ```

**`client/src/app/workbook/[id]/components/MainPane/FolderViewer.tsx`**

- Add `connectorAccountId?: string` prop (~line 24)
- Change store lookup: `hiddenFileFolders.has(folderId)` → `showHiddenConnections.has(connectorAccountId ?? '')`
- Pass `connectorAccountId` from the page components that render `FolderViewer`

### 3b. Show `.scratch` as a top-level virtual folder in the sidebar

The `.scratch/` directory lives at the **git repo root**, not under any `DataFolder` path. It is
never returned by `listDataFolders` or `listFilesByFolder`, so it won't appear in the normal tree.

**Option A — Virtual node in the sidebar (recommended)**

In `ConnectionNode` (TreeNode.tsx), after the list of `TableNode`s, render a read-only
`.scratch` folder node when `showHidden` is true:

- Fetch `.scratch` contents via a new API endpoint (or reuse files API with a special path param)
- Render a non-interactive `FolderNode`-style component that shows the schema files inside
- Mark it visually as read-only (lock icon, muted color)

**Option B — Surface via existing file list API**

Extend `listFilesByFolder` (or add a new route) to accept a raw git path query. When the user
navigates to a connection with hidden files visible, also show a `.scratch` entry that links to
a read-only folder view.

**Recommended approach**: Start with Option A using a minimal virtual node. The `.scratch` entry
should only appear when "Show hidden files" is enabled for that connection.

---

## Rollout Order

1. **Part 1 (server)** — safe to deploy first; fallback read ensures no regression
2. **Part 2 (CLI)** — deploy immediately after Part 1 to minimize the window where old CLI deletes `.scratch/` from git
3. **Part 3 (client)** — independent; can ship at any time after Part 1

---

## Status

- [x] Part 1: Server `writeSchemaToGit` / `readSchemaFromGit`
- [x] Part 2: CLI `diskToFileMap` + upload exclusion guards
- [x] Part 3a: Move "Show hidden files" to connection level
- [x] Part 3b: Show `.scratch` as virtual folder in sidebar
