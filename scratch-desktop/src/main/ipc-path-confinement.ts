/**
 * The enforcement layer for SCR-007 (DEV-11002): a declarative policy for every path-shaped
 * argument the renderer can send over IPC, applied before the handler body runs.
 *
 * `workspace-path-guard.ts` decides whether a single path is acceptable. This module decides *which
 * arguments of which channel* are paths, and is the reason the fix is trustworthy rather than
 * merely present: the policy for the whole IPC surface is one table a reviewer can read top to
 * bottom, instead of ~64 hand-inserted checks that are individually invisible and collectively
 * impossible to audit.
 *
 * ## Fail closed
 *
 * Registering a channel that has no policy entry throws at startup. That is the property worth
 * having — the vulnerability was not that someone wrote a bad check, it was that nobody wrote one
 * at all, and nothing made the omission visible. A new handler now cannot ship without its author
 * stating, in the table, what its arguments mean. `NO_PATH_ARGUMENTS` is how you say "none", and it
 * is deliberately explicit rather than the default.
 *
 * ## Why validation happens here and not inside each operation
 *
 * The IPC boundary is the trust boundary: below it, `workspacePath` is treated as authoritative by
 * `local-files.ts`, `scratchmd.ts`, and the napi layer alike, and several of those already derive
 * relative paths with `relative()` + a `..` check. Those checks are correct but insufficient,
 * because they only prove *the folder is under the workspace root* — with an unvalidated root,
 * `workspacePath = '/'` and `folderPath = '/etc'` satisfies every one of them. Validating the root
 * at the boundary is what makes the existing downstream checks meaningful.
 */

import type { IpcMain, IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import {
  assertSafeSinglePathSegment,
  assertSafeWorkspaceRelativeFragment,
  type PickedParentFolderAllowlist,
  type WorkspacePathGuard,
} from './workspace-path-guard';

/**
 * Where a path lives in a handler's argument list.
 *
 * `argumentIndex` indexes the arguments as the renderer sends them (the Electron `event` is not
 * counted). `propertyPath` reaches into an options object for the handlers that nest a path inside
 * one — `opts.filePath`, `scope.folderPath`, `filter.filePath`.
 */
export interface PathArgumentLocation {
  argumentIndex: number;
  propertyPath?: string[];
}

export type PathArgumentKind =
  /** An absolute path that must itself be a registered workspace root. */
  | 'registeredWorkspaceRoot'
  /** An absolute path that must resolve inside some registered workspace (the root itself counts). */
  | 'pathInsideRegisteredWorkspace'
  /** An array of absolute paths, each confined like `pathInsideRegisteredWorkspace`. */
  | 'pathArrayInsideRegisteredWorkspace'
  /** A possibly-nested relative fragment joined onto a workspace path (`airtable/Base/Table`). */
  | 'workspaceRelativeFragment'
  /** An array of relative fragments, each validated like `workspaceRelativeFragment`. */
  | 'workspaceRelativeFragmentArray'
  /** A single name, joined or interpolated into a filename (`rec1.json`, `default`, a conn dir). */
  | 'singlePathSegment'
  /** The parent directory for a new workspace: must be one the user picked in the native dialog. */
  | 'userPickedParentFolder';

export interface PathArgumentPolicy extends PathArgumentLocation {
  kind: PathArgumentKind;
  /** When true, `undefined`/`null` passes untouched — for genuinely optional path arguments. */
  optional?: boolean;
}

/** The explicit way to declare that a channel takes no path arguments. */
export const NO_PATH_ARGUMENTS: readonly PathArgumentPolicy[] = [];

function readNestedValue(argumentValues: unknown[], location: PathArgumentLocation): unknown {
  let currentValue: unknown = argumentValues[location.argumentIndex];
  for (const propertyName of location.propertyPath ?? []) {
    if (currentValue === null || typeof currentValue !== 'object') {
      return undefined;
    }
    currentValue = (currentValue as Record<string, unknown>)[propertyName];
  }
  return currentValue;
}

/**
 * Arguments are validated but deliberately **passed through unmodified**.
 *
 * Substituting the canonical path looks tempting — it would close the sliver between "the path we
 * checked" and "the path the handler opens". It is wrong here, because absolute paths are an
 * identity the renderer compares by string: `workspaceRelativePosixPath` derives a record's
 * CLI-relative path by string-prefixing `folderPath` against `workspacePath`, and the folder tree
 * and grid key their state on the paths main hands back. Canonicalizing only the arguments that
 * happen to flow through a policy makes those two forms disagree — on macOS a workspace under
 * `/var` becomes `/private/var` on one side of the comparison and not the other, and the prefix
 * match silently fails, so approving a record turns into a no-op with no error anywhere.
 *
 * Validation alone still closes SCR-007: a path that resolves outside every workspace never
 * reaches the handler. What remains is a TOCTOU window, which is documented in
 * `workspace-path-guard.ts` and is not something path substitution would have closed anyway (the
 * swap can happen just as easily after the substitution).
 */
export interface IpcPathConfinementDependencies {
  workspacePathGuard: WorkspacePathGuard;
  pickedParentFolderAllowlist: PickedParentFolderAllowlist;
}

async function applyOnePolicy(
  argumentValues: unknown[],
  policy: PathArgumentPolicy,
  dependencies: IpcPathConfinementDependencies,
): Promise<void> {
  const rawValue = readNestedValue(argumentValues, policy);

  if (policy.optional === true && (rawValue === undefined || rawValue === null)) {
    return;
  }

  const argumentDescription = `argument ${policy.argumentIndex}${
    policy.propertyPath ? `.${policy.propertyPath.join('.')}` : ''
  }`;

  switch (policy.kind) {
    case 'registeredWorkspaceRoot':
      await dependencies.workspacePathGuard.assertPathIsRegisteredWorkspaceRoot(String(rawValue));
      return;

    case 'pathInsideRegisteredWorkspace':
      await dependencies.workspacePathGuard.assertPathInsideRegisteredWorkspace(String(rawValue));
      return;

    case 'pathArrayInsideRegisteredWorkspace': {
      if (!Array.isArray(rawValue)) {
        throw new TypeError(`Expected ${argumentDescription} to be an array of paths`);
      }
      for (const candidatePath of rawValue) {
        await dependencies.workspacePathGuard.assertPathInsideRegisteredWorkspace(String(candidatePath));
      }
      return;
    }

    case 'workspaceRelativeFragment':
      assertSafeWorkspaceRelativeFragment(argumentDescription, String(rawValue));
      return;

    case 'workspaceRelativeFragmentArray': {
      if (!Array.isArray(rawValue)) {
        throw new TypeError(`Expected ${argumentDescription} to be an array of relative paths`);
      }
      for (const fragment of rawValue) {
        assertSafeWorkspaceRelativeFragment(argumentDescription, String(fragment));
      }
      return;
    }

    case 'singlePathSegment':
      assertSafeSinglePathSegment(argumentDescription, String(rawValue));
      return;

    case 'userPickedParentFolder':
      await dependencies.pickedParentFolderAllowlist.assertParentFolderWasPickedByUser(String(rawValue));
      return;

    default: {
      // Exhaustiveness: a new PathArgumentKind must be handled here, not silently ignored.
      const unhandledKind: never = policy.kind;
      throw new Error(`Unhandled path argument kind: ${String(unhandledKind)}`);
    }
  }
}

/**
 * Wraps `ipcMain` so that `handle`/`on` consult `channelPathPolicies` before dispatching.
 *
 * Returns an object with the same `handle`/`on` shape as `ipcMain`, so call sites read unchanged
 * apart from the receiver.
 */
export function createPathConfinedIpcRegistrar(
  ipcMain: IpcMain,
  channelPathPolicies: Readonly<Record<string, readonly PathArgumentPolicy[]>>,
  dependencies: IpcPathConfinementDependencies,
) {
  function lookupPolicies(channel: string): readonly PathArgumentPolicy[] {
    const policies = channelPathPolicies[channel];
    if (policies === undefined) {
      // Fail closed at startup rather than shipping an unconfined channel. See the module header.
      throw new Error(
        `IPC channel "${channel}" has no path-argument policy. Add an entry to IPC_PATH_ARGUMENT_POLICIES ` +
          `(use NO_PATH_ARGUMENTS if it takes no filesystem paths).`,
      );
    }
    return policies;
  }

  async function applyPolicies(channel: string, argumentValues: unknown[]): Promise<void> {
    for (const policy of lookupPolicies(channel)) {
      await applyOnePolicy(argumentValues, policy, dependencies);
    }
  }

  return {
    handle(channel: string, listener: (event: IpcMainInvokeEvent, ...args: never[]) => unknown): void {
      lookupPolicies(channel); // Surface a missing policy at registration, not on first invoke.
      ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        await applyPolicies(channel, args);
        return (listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown)(event, ...args);
      });
    },

    on(channel: string, listener: (event: IpcMainEvent, ...args: never[]) => void): void {
      lookupPolicies(channel);
      ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
        // `ipcMain.on` channels are fire-and-forget sends with no reply path, so a rejection has
        // nowhere to surface. Log and drop rather than letting it become an unhandled rejection.
        void applyPolicies(channel, args)
          .then(() => {
            (listener as (event: IpcMainEvent, ...args: unknown[]) => void)(event, ...args);
          })
          .catch((error: unknown) => {
            console.error(`[scratch] Rejected ${channel}:`, error instanceof Error ? error.message : String(error));
          });
      });
    },

    /** Registers a one-shot listener; used for app-quit confirmation, which takes no paths. */
    once(channel: string, listener: (event: IpcMainEvent, ...args: never[]) => void): void {
      lookupPolicies(channel);
      ipcMain.once(channel, listener as (event: IpcMainEvent, ...args: unknown[]) => void);
    },
  };
}
