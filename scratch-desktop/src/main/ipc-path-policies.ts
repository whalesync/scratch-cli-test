/**
 * The path-argument policy for every renderer-facing IPC channel (SCR-007 / DEV-11002).
 *
 * One row per channel. A channel missing from this table cannot be registered — see
 * `ipc-path-confinement.ts` for why that fail-closed behaviour is the point of the design.
 *
 * Argument indices count the arguments the renderer sends; the Electron `event` parameter is not
 * counted. So for `(_, workspacePath, folderPath)`, `workspacePath` is index 0.
 *
 * Reading the table:
 *
 *   workspaceRoot(i)      argument i must BE a registered workspace root
 *   insideWorkspace(i)    argument i must be an absolute path within some registered workspace
 *   relativeFragment(i)   argument i is a workspace-relative path fragment (`airtable/Base/Table`)
 *   segment(i)            argument i is a single name (`rec1.json`, `default`, a connection dir)
 *
 * `relativeFragment` and `segment` matter independently of the root checks: handlers such as
 * `files:read-connection-schema` and `files:write-validation-config` join a renderer string onto a
 * perfectly valid workspace root, so confining the root alone still leaves `../../..` able to walk
 * out before any filesystem call happens.
 */

import { APP_QUIT_CONFIRMED_CHANNEL } from '../shared/lifecycle-events';
import { NO_PATH_ARGUMENTS, type PathArgumentPolicy } from './ipc-path-confinement';

function workspaceRoot(argumentIndex: number, optional = false): PathArgumentPolicy {
  return { kind: 'registeredWorkspaceRoot', argumentIndex, optional };
}

function insideWorkspace(argumentIndex: number, optional = false): PathArgumentPolicy {
  return { kind: 'pathInsideRegisteredWorkspace', argumentIndex, optional };
}

function insideWorkspaceArray(argumentIndex: number): PathArgumentPolicy {
  return { kind: 'pathArrayInsideRegisteredWorkspace', argumentIndex };
}

function relativeFragment(argumentIndex: number, optional = false, propertyPath?: string[]): PathArgumentPolicy {
  return { kind: 'workspaceRelativeFragment', argumentIndex, optional, propertyPath };
}

function segment(argumentIndex: number, optional = false, propertyPath?: string[]): PathArgumentPolicy {
  return { kind: 'singlePathSegment', argumentIndex, optional, propertyPath };
}

function nestedInsideWorkspace(argumentIndex: number, propertyPath: string[]): PathArgumentPolicy {
  return { kind: 'pathInsideRegisteredWorkspace', argumentIndex, optional: true, propertyPath };
}

function nestedWorkspaceRoot(argumentIndex: number, propertyPath: string[]): PathArgumentPolicy {
  return { kind: 'registeredWorkspaceRoot', argumentIndex, optional: true, propertyPath };
}

export const IPC_PATH_ARGUMENT_POLICIES: Readonly<Record<string, readonly PathArgumentPolicy[]>> = {
  // ── Auth, preferences, updater, window: no filesystem paths ──
  'auth:get-credentials': NO_PATH_ARGUMENTS,
  'auth:save-credentials': NO_PATH_ARGUMENTS,
  'auth:clear-credentials': NO_PATH_ARGUMENTS,
  'auth:is-token-expired': NO_PATH_ARGUMENTS,
  // The URL, not a path — already allowlisted by `isSafeExternalUrl` (SCR-003).
  'auth:open-external': NO_PATH_ARGUMENTS,
  'preferences:get-current-workspace-id': NO_PATH_ARGUMENTS,
  'preferences:set-current-workspace-id': NO_PATH_ARGUMENTS,
  'preferences:get-workbook-settings': NO_PATH_ARGUMENTS,
  'preferences:set-workbook-setting': NO_PATH_ARGUMENTS,
  'scratch:prepare-workspace-index': NO_PATH_ARGUMENTS,
  'scratch:refresh-paths': NO_PATH_ARGUMENTS,
  'scratch:show-native-context-menu': NO_PATH_ARGUMENTS,
  'scratch:toggle-devtools': NO_PATH_ARGUMENTS,
  'scratch:get-app-version': NO_PATH_ARGUMENTS,
  'updater:check-now': NO_PATH_ARGUMENTS,
  'updater:quit-and-install': NO_PATH_ARGUMENTS,

  // ── Workspace lifecycle ──
  'scratch:get-workspaces-registry': NO_PATH_ARGUMENTS,
  // Main opens the native dialog itself and returns the result; nothing comes in.
  'scratch:pick-parent-folder': NO_PATH_ARGUMENTS,
  'scratch:create-workspace': NO_PATH_ARGUMENTS,
  // `cwd` is where a NEW workspace gets created, so it cannot be in the registry yet. It is
  // confined instead to directories the user chose in the native dialog (or the parent of a
  // workspace they already have), because this path becomes the CLI's working directory.
  'scratch:init-workspace': [{ kind: 'userPickedParentFolder', argumentIndex: 1 }],
  // Takes a workbook id only; the path is looked up from the registry by main.
  'scratch:remove-workspace': NO_PATH_ARGUMENTS,
  // Already performs its own realpath containment check; the policy makes that uniform.
  'scratch:open-agent-deep-link': [workspaceRoot(1), relativeFragment(3, true)],

  // ── Review / publish operations (workspace root + optional folder) ──
  'scratch:clear-folder-index': [workspaceRoot(0), insideWorkspace(1)],
  'scratch:rerun-validation': [workspaceRoot(0), nestedInsideWorkspace(1, ['folderPath'])],
  'scratch:accept-all-changes': [workspaceRoot(0), insideWorkspace(1, true)],
  'scratch:discard-all-changes': [workspaceRoot(0), insideWorkspace(1, true)],
  'scratch:reject-all-changes': [workspaceRoot(0), insideWorkspace(1, true)],
  'scratch:accept-record': [workspaceRoot(0), relativeFragment(1)],
  'scratch:accept-records': [workspaceRoot(0), { kind: 'workspaceRelativeFragmentArray', argumentIndex: 1 }],
  'scratch:reject-record': [workspaceRoot(0), relativeFragment(1)],
  'scratch:discard-record': [workspaceRoot(0), relativeFragment(1)],
  'scratch:list-unreviewed-changes': [workspaceRoot(0)],
  'scratch:list-unpushed-changes': [workspaceRoot(0)],
  'scratch:upload-workspace-changes': [workspaceRoot(0), relativeFragment(1, true, ['filePath'])],
  'scratch:reconcile-published-record': [workspaceRoot(0), relativeFragment(1)],
  'scratch:reconcile-after-publish': [workspaceRoot(0)],
  'scratch:pull-workspace-changes': [workspaceRoot(0), relativeFragment(1, true, ['filePath'])],
  'scratch:list-local-syncs': [workspaceRoot(0)],
  'scratch:validate-local-sync': [workspaceRoot(0), segment(1)],
  'scratch:start-run-local-sync': [workspaceRoot(0), segment(1)],
  'scratch:pull-all-linked-tables': [workspaceRoot(0)],
  'scratch:record-tree': [workspaceRoot(0), relativeFragment(1)],
  'scratch:watch-workspace-files': [workspaceRoot(0)],
  'scratch:clear-workspace-file-watch': [workspaceRoot(0, true)],
  'publish-plan:revert': [workspaceRoot(0), relativeFragment(2, true, ['filePath']), segment(2, true, ['filename'])],

  // ── OS-level reveal / launch ──
  // `shell.openPath` LAUNCHES what it is given, so an unconfined path here is code execution, not
  // just disclosure. Same for the terminal spawn, which takes the path as its working directory.
  'scratch:show-in-folder': [insideWorkspace(0)],
  'scratch:show-item-in-folder': [insideWorkspace(0)],
  'scratch:show-workspace-log': [workspaceRoot(0)],
  'scratch:open-in-terminal': [insideWorkspace(0)],

  // ── File reads / writes ──
  'files:workspace-config': [workspaceRoot(0)],
  'files:list-folders': [workspaceRoot(0)],
  'files:folder-metadata': [insideWorkspace(0), workspaceRoot(1)],
  'files:list-files': [insideWorkspace(0)],
  'files:read-file': [insideWorkspace(0)],
  // The two channels named in the Oneleet finding.
  'files:read-file-text-raw': [insideWorkspace(0)],
  'files:write-file-text-raw': [insideWorkspace(0)],
  'files:read-batch': [insideWorkspaceArray(0)],
  'files:read-schema': [workspaceRoot(0), segment(1)],
  'files:read-connection-schema': [workspaceRoot(0), relativeFragment(1)],
  // `viewName` is interpolated as `${viewName}.json`, so a separator alone redirects the read.
  'files:read-connection-view': [insideWorkspace(0), workspaceRoot(1), segment(2)],
  'files:read-grid-data': [insideWorkspace(0), nestedWorkspaceRoot(1, ['workspacePath'])],
  'files:read-folder-statuses': [insideWorkspace(0), workspaceRoot(1)],
  'files:find-record-offset': [insideWorkspace(0), workspaceRoot(1), segment(2)],
  'files:read-diff-grid-data': [insideWorkspace(0), workspaceRoot(1)],
  'files:read-diff-record-data': [insideWorkspace(0), workspaceRoot(1), segment(2)],
  'files:get-validation-results': [workspaceRoot(0), insideWorkspace(1), segment(2)],
  'files:get-folder-validation-results': [workspaceRoot(0), insideWorkspace(1)],
  'files:get-validation-stats': [workspaceRoot(0)],
  'files:get-review-stats': [workspaceRoot(0)],
  'files:get-folder-validation-sample': [workspaceRoot(0), relativeFragment(1)],
  'files:get-validation-configs': [workspaceRoot(0)],
  // Both `connection` and `folderPath` are joined onto the root and then written to, which made
  // this the widest write primitive after `files:write-file-text-raw`.
  'files:write-validation-config': [workspaceRoot(0), segment(1), relativeFragment(2)],
  'files:ensure-schema-validator-seeded': [workspaceRoot(0)],
  'files:accept-cell-input-text': [insideWorkspace(0), workspaceRoot(1), segment(2)],
  'files:accept-cell-change': [insideWorkspace(0), workspaceRoot(1), segment(2)],
  'files:undo-approved-cell-change': [insideWorkspace(0), workspaceRoot(1), segment(2)],
  'files:reject-cell-change': [insideWorkspace(0), workspaceRoot(1), segment(2)],
  'files:restore-deleted-record': [insideWorkspace(0), workspaceRoot(1), segment(2)],
  'files:discard-created-record': [insideWorkspace(0), workspaceRoot(1), segment(2)],
  'files:accept-field-changes': [insideWorkspace(0), workspaceRoot(1)],
  'files:reject-field-changes': [insideWorkspace(0), workspaceRoot(1)],

  // ── Per-workspace logging (fire-and-forget sends) ──
  // These append to `<workspacePath>/workspace.log` and rotate it, so an unconfined root was an
  // append-plus-rename primitive against any directory on disk.
  'scratch:log-api-call': [workspaceRoot(0)],
  'scratch:log-session': [workspaceRoot(0)],
  'scratch:log-publish-job': [workspaceRoot(0)],

  // ── App lifecycle ──
  // The renderer's "yes, I'm done saving" acknowledgement during quit; carries no payload.
  [APP_QUIT_CONFIRMED_CHANNEL]: NO_PATH_ARGUMENTS,
};
