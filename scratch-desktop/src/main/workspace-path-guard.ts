/**
 * Path confinement for every filesystem path the renderer hands to the main process
 * (DEV-11002 / Oneleet finding SCR-007).
 *
 * The renderer-exposed IPC surface in `index.ts` accepts absolute paths and passes them straight to
 * `fs` reads/writes, `shell.openPath`, `shell.showItemInFolder`, and the `scratchmd` CLI's working
 * directory. None of that checked where the path pointed, so any JavaScript execution in the
 * renderer (XSS, injected record content, a malicious `__filename` inside a record file) could read
 * and write anywhere the OS user could. Oneleet demonstrated it by reading the Windows hosts file
 * and writing into the Startup folder.
 *
 * Two consequences are worse than a generic arbitrary-file-write, and are why this guard covers the
 * whole path-taking surface rather than only the two handlers named in the finding:
 *
 *   - `~/.scratchmd/credentials.yaml` stores the Scratch **API token in plaintext**
 *     (`scratch-git-2/src/cli/config/credentials.rs`). An unconfined read is account takeover, not
 *     just local file disclosure.
 *   - `shell.openPath` *launches* whatever it is given. Paired with the arbitrary write it is
 *     immediate code execution, with no reboot needed for the Startup-folder persistence path.
 *
 * ## The policy
 *
 * A path is allowed only when it resolves inside a directory the user themselves chose as a
 * workspace — a root currently listed in the scratchmd registry at `~/.scratchmd/workspaces.yaml`.
 * That registry is the right allowlist because it is exactly the set of folders the user picked
 * through the native directory dialog, which the renderer cannot forge. Everything else on disk —
 * including `~/.scratchmd` itself, so the credentials file above stays out of reach — is denied.
 *
 * ## Why canonicalization, not string prefixing
 *
 * Containment is checked on **realpath'd** paths, because a plain `startsWith` on the raw strings
 * loses to three separate tricks:
 *
 *   - `..` traversal (`/ws/../../etc/passwd`) — beaten by resolving first.
 *   - Symlinks. A symlink *inside* a workspace pointing out of it would otherwise pass a prefix
 *     check while reading/writing the target. Records are synced from external services, so an
 *     attacker-influenced symlink landing in a workspace is a real path, not a hypothetical.
 *   - Sibling-prefix collisions (`/home/me/work-evil` vs. the root `/home/me/work`) — beaten by
 *     comparing path segments via `relative()` instead of characters.
 *
 * Roots are canonicalized too: on macOS a workspace under `/tmp` or `/var` reaches us as
 * `/private/...` once resolved, so comparing a resolved candidate against an unresolved root would
 * reject legitimate paths. (The Rust CLI already canonicalizes on write via `dunce::canonicalize`,
 * but it falls back to the raw path when that fails, so we cannot assume it.)
 *
 * For writes the target file usually does not exist yet, and `realpath` fails on a missing path. So
 * canonicalization walks up to the nearest **existing** ancestor, resolves that, and re-appends the
 * missing segments. The symlink protection survives because every component that exists — the part
 * an attacker could have pointed elsewhere — is still resolved.
 *
 * ## What this does not claim to do
 *
 * Confinement is checked before the filesystem call, so a symlink swapped into place in the window
 * between the check and the call would not be caught (TOCTOU). Closing that needs `O_NOFOLLOW`-style
 * handle-based I/O, which Node does not expose portably. The guard is still worth having: it turns
 * "read and write anywhere, deterministically" into "win a narrow race against a path you already
 * had to get inside a workspace to create."
 *
 * This module deliberately lives apart from `index.ts`: `index.ts` runs Electron app lifecycle side
 * effects at import time, so it cannot be imported from a unit test.
 */

import { realpath } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path';

/**
 * Thrown when a renderer-supplied path resolves outside every registered workspace root.
 *
 * Carries the offending path for the main-process log only. IPC handlers surface a generic message
 * to the renderer instead, so a compromised renderer cannot use the error text as a filesystem
 * oracle — distinguishing "exists but denied" from "does not exist" would let it map the disk.
 */
export class PathOutsideWorkspaceError extends Error {
  public readonly attemptedPath: string;

  constructor(attemptedPath: string, reason: string) {
    super(`Refusing filesystem access outside registered workspaces: ${reason} (${attemptedPath})`);
    this.name = 'PathOutsideWorkspaceError';
    this.attemptedPath = attemptedPath;
  }
}

/**
 * True when `canonicalCandidatePath` is `canonicalRootPath` itself or sits beneath it.
 *
 * Compares by path segment (via `relative`) rather than string prefix, so the root `/home/me/work`
 * does not vacuously contain the unrelated sibling directory `/home/me/work-evil`.
 *
 * Both arguments must already be canonicalized; this function performs no I/O.
 */
export function isCanonicalPathContainedWithinCanonicalRoot(
  canonicalCandidatePath: string,
  canonicalRootPath: string,
): boolean {
  const candidateRelativeToRoot = relative(canonicalRootPath, canonicalCandidatePath);

  if (candidateRelativeToRoot === '') {
    return true; // The candidate is the root directory itself.
  }

  // `relative` yields an absolute path when the two sides are on different Windows volumes, and a
  // leading `..` segment whenever the candidate escapes upward.
  if (isAbsolute(candidateRelativeToRoot)) {
    return false;
  }

  return candidateRelativeToRoot !== '..' && !candidateRelativeToRoot.startsWith(`..${sep}`);
}

/**
 * Resolves `pathToCanonicalize` through any symlinks, tolerating a leaf (or a whole trailing chain
 * of segments) that does not exist yet — the normal case when confining the destination of a write.
 *
 * Returns the canonical form of the deepest existing ancestor with the non-existent segments
 * re-appended, so the result is comparable against a canonicalized root.
 */
export async function canonicalizePathAllowingMissingTrailingSegments(pathToCanonicalize: string): Promise<string> {
  const segmentsBelowNearestExistingAncestor: string[] = [];
  let pathBeingProbed = resolve(pathToCanonicalize);

  for (;;) {
    try {
      const canonicalExistingAncestor = await realpath(pathBeingProbed);
      return segmentsBelowNearestExistingAncestor.length === 0
        ? canonicalExistingAncestor
        : join(canonicalExistingAncestor, ...segmentsBelowNearestExistingAncestor.reverse());
    } catch (error) {
      const errorCode = (error as NodeJS.ErrnoException).code;
      // ENOTDIR: an ancestor exists but is a file, so the deeper path can never exist. Keep walking
      // up rather than failing — containment stays decidable, and the real filesystem call that
      // follows is what should report the error to the user.
      if (errorCode !== 'ENOENT' && errorCode !== 'ENOTDIR') {
        throw error;
      }

      const parentPath = dirname(pathBeingProbed);
      if (parentPath === pathBeingProbed) {
        // Walked to the filesystem root without finding anything that exists. Nothing can be
        // canonicalized, so fall back to the lexically resolved path; containment will reject it
        // unless it happens to sit under a root.
        return resolve(pathToCanonicalize);
      }

      segmentsBelowNearestExistingAncestor.push(basename(pathBeingProbed));
      pathBeingProbed = parentPath;
    }
  }
}

/**
 * Thrown when a renderer-supplied *relative* path segment could escape the directory it is joined
 * onto. Separate from `PathOutsideWorkspaceError` because it is caught before any path is built.
 */
export class UnsafeRelativePathSegmentError extends Error {
  constructor(argumentName: string, offendingValue: string, reason: string) {
    super(`Refusing unsafe ${argumentName}: ${reason} (${JSON.stringify(offendingValue)})`);
    this.name = 'UnsafeRelativePathSegmentError';
  }
}

/**
 * Validates a renderer-supplied path fragment that the main process will join onto a workspace
 * path — `relPath`, `folderPath`, and the connection directory name in the validation-config and
 * schema/view readers.
 *
 * These are a second, quieter half of SCR-007. Confining the absolute `workspacePath` argument to a
 * registered root is not sufficient on its own: `readConnectionSchema` builds
 * `join(workspacePath, '.scratch', 'connections/scratch', relPath, 'schema.json')`, so a valid
 * workspace root plus `relPath = '../../../../..'` still walks out of the workspace before any
 * filesystem call happens. Rejecting the fragment up front is cheaper and clearer than re-checking
 * every join site scattered through `local-files.ts`.
 *
 * Nested fragments (`airtable/Base/Table`) are legitimate, so separators are allowed; `..` segments
 * and absolute paths are not. Backslashes are treated as separators regardless of platform, because
 * `path.join` on Windows would, and a Linux/macOS build should not disagree about what a string
 * means when the same value round-trips through a synced workspace.
 */
export function assertSafeWorkspaceRelativeFragment(argumentName: string, fragment: string): string {
  if (typeof fragment !== 'string' || fragment === '') {
    throw new UnsafeRelativePathSegmentError(argumentName, String(fragment), 'value is empty');
  }

  if (fragment.includes('\0')) {
    throw new UnsafeRelativePathSegmentError(argumentName, fragment, 'value contains a NUL byte');
  }

  if (isAbsolute(fragment) || fragment.startsWith('/') || fragment.startsWith('\\')) {
    throw new UnsafeRelativePathSegmentError(argumentName, fragment, 'value must be relative');
  }

  // Windows drive-relative forms (`C:foo`) resolve against that drive's current directory rather
  // than the path we join onto, so they escape without ever containing `..`.
  if (/^[A-Za-z]:/.test(fragment)) {
    throw new UnsafeRelativePathSegmentError(argumentName, fragment, 'value must not be drive-qualified');
  }

  const segments = fragment.split(/[/\\]+/);
  if (segments.some((segment) => segment === '..')) {
    throw new UnsafeRelativePathSegmentError(argumentName, fragment, 'value must not traverse upward');
  }

  return fragment;
}

/**
 * Like `assertSafeWorkspaceRelativeFragment`, but for fragments that must name a single entry —
 * `filename`, `folderName`, `viewName`, `syncName`, and the connection directory name.
 *
 * Several of these are interpolated into a filename rather than joined as a path
 * (`` `${viewName}.json` `` in `readConnectionView`, `` `${folderName}.json` `` in `readSchema`), so
 * a separator alone is enough to redirect the read into another directory even with no `..`.
 */
export function assertSafeSinglePathSegment(argumentName: string, segment: string): string {
  assertSafeWorkspaceRelativeFragment(argumentName, segment);

  if (/[/\\]/.test(segment)) {
    throw new UnsafeRelativePathSegmentError(argumentName, segment, 'value must not contain a path separator');
  }

  if (segment === '.') {
    throw new UnsafeRelativePathSegmentError(argumentName, segment, 'value must name an entry');
  }

  return segment;
}

/**
 * Tracks the parent directories the user chose in the native folder dialog, so that
 * `scratch:init-workspace` can be confined even though its target is by definition *not* yet a
 * registered workspace.
 *
 * The registry cannot be the allowlist here — the whole point of the handler is to create a
 * workspace somewhere new — but the renderer must not get to name an arbitrary directory either,
 * since `scratchmd workspaces init` runs with that directory as its working directory. What makes
 * a location legitimate is that it came out of `dialog.showOpenDialog`, which only the main process
 * can invoke and the user personally confirmed. So main remembers what it handed out and accepts
 * only those values back.
 *
 * Entries are kept for the life of the process rather than consumed on first use: the re-init flow
 * (`ReinitWorkspaceModal`) legitimately calls init again for the same parent, and a user may create
 * several workspaces under one folder they picked once. The set is small and bounded by the number
 * of times a human clicked through a dialog.
 */
export interface PickedParentFolderAllowlist {
  /** Records a directory the user selected in the native dialog. */
  rememberUserPickedParentFolder(pickedPath: string): Promise<void>;
  /** Throws `PathOutsideWorkspaceError` unless `candidatePath` was previously picked by the user. */
  assertParentFolderWasPickedByUser(candidatePath: string): Promise<string>;
}

export function createPickedParentFolderAllowlist(
  readRegisteredWorkspaceRoots: RegisteredWorkspaceRootsReader,
): PickedParentFolderAllowlist {
  const canonicalUserPickedParentFolders = new Set<string>();

  return {
    async rememberUserPickedParentFolder(pickedPath: string): Promise<void> {
      canonicalUserPickedParentFolders.add(await canonicalizePathAllowingMissingTrailingSegments(pickedPath));
    },

    async assertParentFolderWasPickedByUser(candidatePath: string): Promise<string> {
      if (typeof candidatePath !== 'string' || candidatePath === '' || candidatePath.includes('\0')) {
        throw new PathOutsideWorkspaceError(String(candidatePath), 'workspace parent folder is empty or malformed');
      }
      if (!isAbsolute(candidatePath)) {
        throw new PathOutsideWorkspaceError(candidatePath, 'workspace parent folder is not absolute');
      }

      const canonicalCandidatePath = await canonicalizePathAllowingMissingTrailingSegments(candidatePath);
      if (canonicalUserPickedParentFolders.has(canonicalCandidatePath)) {
        return canonicalCandidatePath;
      }

      // The re-init flow derives the parent of an existing workspace rather than re-prompting, so a
      // directory that already contains a registered workspace is equally user-chosen.
      for (const registeredRoot of await readRegisteredWorkspaceRoots()) {
        let canonicalRegisteredRoot: string;
        try {
          canonicalRegisteredRoot = await realpath(registeredRoot);
        } catch {
          continue;
        }
        if (dirname(canonicalRegisteredRoot) === canonicalCandidatePath) {
          return canonicalCandidatePath;
        }
      }

      throw new PathOutsideWorkspaceError(candidatePath, 'workspace parent folder was not chosen by the user');
    },
  };
}

/** Supplies the current set of registered workspace roots. Injected so tests need no real registry. */
export type RegisteredWorkspaceRootsReader = () => Promise<string[]>;

export interface WorkspacePathGuard {
  /**
   * Returns the canonical form of `candidatePath` once confirmed to sit inside a registered
   * workspace, or throws `PathOutsideWorkspaceError`.
   *
   * Callers should use the returned canonical path for the subsequent filesystem call rather than
   * the original string, so the path that was checked is the path that gets used.
   *
   * `mustExist: true` additionally rejects paths that do not resolve to anything on disk; use it
   * for reads, where a missing path is never legitimate. Writes leave it false so a new file can be
   * created inside a workspace.
   */
  assertPathInsideRegisteredWorkspace(candidatePath: string, options?: { mustExist?: boolean }): Promise<string>;

  /**
   * Like `assertPathInsideRegisteredWorkspace`, but requires the path to BE a registered root
   * rather than merely sit inside one.
   *
   * Stricter on purpose: a `workspacePath` argument is treated as authoritative by everything
   * downstream — it is the CLI's working directory and the base every `relative()` containment
   * check measures against — so accepting a subdirectory there would let a caller re-root the
   * workspace and make those downstream checks measure the wrong thing.
   */
  assertPathIsRegisteredWorkspaceRoot(candidatePath: string): Promise<string>;

  /** Drops the cached root set, forcing the next check to re-read the registry. */
  invalidateCachedWorkspaceRoots(): void;
}

/**
 * Builds the guard used by the IPC layer.
 *
 * The resolved root set is cached because the hot handlers (`files:read-batch` over a grid page,
 * per-record reads while scrolling) would otherwise re-read the registry and realpath every root on
 * every call. Cache misses re-read once before rejecting, so a workspace registered moments ago —
 * by `scratch:init-workspace`, or by the CLI outside the app — is honoured without a restart and
 * without the IPC layer having to remember to invalidate.
 */
export function createWorkspacePathGuard(
  readRegisteredWorkspaceRoots: RegisteredWorkspaceRootsReader,
): WorkspacePathGuard {
  let cachedCanonicalWorkspaceRoots: string[] | null = null;

  async function loadCanonicalWorkspaceRoots(): Promise<string[]> {
    const registeredRoots = await readRegisteredWorkspaceRoots();
    const canonicalRoots: string[] = [];
    for (const registeredRoot of registeredRoots) {
      try {
        canonicalRoots.push(await realpath(registeredRoot));
      } catch {
        // A registry row whose folder is gone cannot confine anything; skip it rather than fail
        // every check because one stale entry survived pruning.
      }
    }
    return canonicalRoots;
  }

  async function getCanonicalWorkspaceRoots(forceReload: boolean): Promise<string[]> {
    if (forceReload || cachedCanonicalWorkspaceRoots === null) {
      cachedCanonicalWorkspaceRoots = await loadCanonicalWorkspaceRoots();
    }
    return cachedCanonicalWorkspaceRoots;
  }

  /** Shared front half: reject values that are not usable absolute paths, then canonicalize. */
  async function canonicalizeRendererSuppliedPath(candidatePath: string): Promise<string> {
    if (typeof candidatePath !== 'string' || candidatePath === '') {
      throw new PathOutsideWorkspaceError(String(candidatePath), 'path is empty');
    }

    // A NUL byte truncates the path inside libc, so the string Node checked and the path the
    // kernel opens can differ. Node throws on this itself, but rejecting here keeps the guard
    // from ever reasoning about a string that means something else downstream.
    if (candidatePath.includes('\0')) {
      throw new PathOutsideWorkspaceError(candidatePath, 'path contains a NUL byte');
    }

    if (!isAbsolute(candidatePath)) {
      // A relative path would resolve against the main process's cwd, which is not a workspace
      // and is not something the renderer should be able to reach.
      throw new PathOutsideWorkspaceError(candidatePath, 'path is not absolute');
    }

    return canonicalizePathAllowingMissingTrailingSegments(candidatePath);
  }

  /**
   * Runs `matchesSomeRoot` against the cached root set, retrying once against a freshly loaded set
   * before giving up — so a workspace registered moments ago is honoured without a restart, while
   * the steady-state case still costs no I/O.
   */
  async function satisfiedByCachedOrReloadedRoots(
    matchesSomeRoot: (canonicalRoots: string[]) => boolean,
  ): Promise<boolean> {
    if (matchesSomeRoot(await getCanonicalWorkspaceRoots(false))) {
      return true;
    }
    return matchesSomeRoot(await getCanonicalWorkspaceRoots(true));
  }

  return {
    invalidateCachedWorkspaceRoots(): void {
      cachedCanonicalWorkspaceRoots = null;
    },

    async assertPathInsideRegisteredWorkspace(
      candidatePath: string,
      options?: { mustExist?: boolean },
    ): Promise<string> {
      const canonicalCandidatePath = await canonicalizeRendererSuppliedPath(candidatePath);

      const isInsideSomeRoot = await satisfiedByCachedOrReloadedRoots((canonicalRoots) =>
        canonicalRoots.some((canonicalRoot) =>
          isCanonicalPathContainedWithinCanonicalRoot(canonicalCandidatePath, canonicalRoot),
        ),
      );
      if (!isInsideSomeRoot) {
        throw new PathOutsideWorkspaceError(candidatePath, 'path is outside every registered workspace');
      }

      if (options?.mustExist === true) {
        try {
          await realpath(canonicalCandidatePath);
        } catch {
          throw new PathOutsideWorkspaceError(candidatePath, 'path does not exist');
        }
      }

      return canonicalCandidatePath;
    },

    async assertPathIsRegisteredWorkspaceRoot(candidatePath: string): Promise<string> {
      const canonicalCandidatePath = await canonicalizeRendererSuppliedPath(candidatePath);

      const isItselfARoot = await satisfiedByCachedOrReloadedRoots((canonicalRoots) =>
        canonicalRoots.includes(canonicalCandidatePath),
      );
      if (!isItselfARoot) {
        throw new PathOutsideWorkspaceError(candidatePath, 'path is not a registered workspace root');
      }

      return canonicalCandidatePath;
    },
  };
}
