# Connector Folder Naming: Drop Service Prefix, Preserve Legacy Layouts

**Date**: 2026-05-08
**Author**: Chris Hoefgen
**Status**: Implemented
**Scope**: [scratch-git-2/src/cli/](../../scratch-git-2/src/cli/) (scratchmd CLI) + [scratch-cli-tests/](../../scratch-cli-tests/) integration test driver

## Problem

When `scratchmd` materializes a workspace on disk, each connector account gets its own top-level folder. The folder name was historically `"<Service> - <DisplayName>"` (e.g. `Airtable - My Base`, `POSTGRES - Smoke Postgres`). The service prefix is noisy:

- The display name is already chosen by the user to identify the connection.
- Users browsing the workspace in Finder / VS Code rarely need the service tag — they know what kind of connection it is.
- Two connections to the same service with similar display names already disambiguate via the display name itself; the service prefix adds nothing.

Goal: name connector folders using just the (sanitized) display name.

Constraint: workspaces initialized before this change already have folders on disk in the legacy `"<Service> - <DisplayName>"` form. We do not want to force users through a migration.

## Key Decisions

### D1. Drop the service prefix for new connector folders

`connector_dir_name(display_name)` now returns `sanitize_filename(display_name)`. Fresh `scratchmd workspaces init` produces folders like `My Base/` instead of `Airtable - My Base/`.

### D2. Do not migrate existing workspaces

The connector folder name is persisted in the workspace marker (`ConnectionEntry.dir_name` in [.scratch/workspace](../../scratch-git-2/src/cli/config/markers.rs)). All read paths look it up from the marker rather than recomputing, so existing workspaces continue to work untouched. No rename, no migration command — the legacy name stays on disk forever (or until the user deletes the workspace).

### D3. New connections in legacy workspaces follow the legacy pattern

If a workspace already contains connector folders in the `"<Service> - <DisplayName>"` form and the user adds a new connection (via `scratchmd workspaces sync` etc.), the new folder uses the legacy form too. Rationale: a single workspace should have one naming scheme on disk. A mixed layout (`Airtable - My Base/` next to `Webflow Site/`) would be jarring and would suggest a bug.

Detection is purely structural — we don't need a stored "version" flag. For each existing `ConnectionEntry`, we recompute both candidate names (`<service> - <display_name>` and `<display_name>`); if any entry's persisted `dir_name` matches the legacy formula and the two formulas differ, the workspace is legacy. Manually-renamed folders that match neither candidate are treated as new-pattern (conservative default for fresh inits added after a manual rename).

### D4. Sanitization unchanged

`sanitize_filename` (replaces `/ \ : * ? " < > |` with `-`) applies to both old and new patterns. No new sanitization rules; the only change is what gets fed into it.

## Changes

### scratchmd CLI ([scratch-git-2/](../../scratch-git-2/))

| File | Change |
|---|---|
| [src/cli/config/markers.rs](../../scratch-git-2/src/cli/config/markers.rs) | `connector_dir_name(display_name)` now skips service prefix. Added `connector_dir_name_legacy(service, display_name)` and `workspace_uses_legacy_naming(connections)` helpers. |
| [src/cli/commands/workspaces.rs](../../scratch-git-2/src/cli/commands/workspaces.rs) | `setup_connection` now takes `dir_name: &str` from the caller (no longer recomputes internally). `init_v2` zips `connector_accounts` with the `connections` vec to pass dir_name through. |
| [src/cli/commands/files.rs](../../scratch-git-2/src/cli/commands/files.rs) | `sync_workspace_structure` calls `workspace_uses_legacy_naming` once on the existing marker, then a `dir_name_for(ca)` closure picks legacy or new format consistently for both the setup loop and the marker rewrite. |
| [src/cli/config/tests/markers.rs](../../scratch-git-2/src/cli/config/tests/markers.rs) | New unit tests covering both naming helpers and the legacy detection (empty / all-new / all-legacy / mixed / manually-renamed). |
| [src/cli/commands/tests/workspaces.rs](../../scratch-git-2/src/cli/commands/tests/workspaces.rs) | Updated `init_v2_produces_workspace_structure_expected_by_desktop` to assert the new folder name (`My CMS` instead of `WORDPRESS - My CMS`). |

### Integration test driver ([scratch-cli-tests/](../../scratch-cli-tests/))

The Jest specs in `tests/` already read `dirName` dynamically from the workspace marker / CLI JSON output, so they needed no changes. Only the imperative driver scripts had hardcoded paths:

| File | Change |
|---|---|
| [scripts/driver-run.js](../../scratch-cli-tests/scripts/driver-run.js) | `getConnectionDir`, `getMasterConnectionDir`, `getDirtyConnectionDir` — replaced `"POSTGRES - Smoke Postgres"` with `"Smoke Postgres"`. |
| [scripts/driver-push.js](../../scratch-cli-tests/scripts/driver-push.js) | `listRecordFiles` — same replacement. |

## Behavior Matrix

| Scenario | Connector folder name |
|---|---|
| `scratchmd workspaces init` on a fresh workbook | `<DisplayName>` |
| `scratchmd workspaces init` on an existing workbook (re-init) | `<DisplayName>` (init wipes & rewrites the marker) |
| Existing legacy workspace, no changes | `<Service> - <DisplayName>` (unchanged — read from marker) |
| Existing legacy workspace, add a new connection via sync | `<Service> - <DisplayName>` for the new one too (legacy detected) |
| Existing new-pattern workspace, add a new connection via sync | `<DisplayName>` |
| Existing workspace where folders were manually renamed to neither pattern | New connections use `<DisplayName>` (treated as new-pattern) |

## Caveat — driver-push against pre-change workspaces

`scripts/driver-push.js` is a development helper that runs against an *existing* workspace created by `driver-run.js`. If a developer has a workspace on disk that was created with `driver-run` *before* this change (legacy folder), `driver-push` will fail to find the hardcoded `"Smoke Postgres"` path. The fix is to re-run `driver-run` to recreate the workspace under the new pattern. We chose not to make these helpers marker-aware because they only target one specific connection name and the cost of re-running `driver-run` is low.
