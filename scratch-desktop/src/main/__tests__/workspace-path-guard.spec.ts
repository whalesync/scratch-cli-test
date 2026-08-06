import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertSafeSinglePathSegment,
  assertSafeWorkspaceRelativeFragment,
  canonicalizePathAllowingMissingTrailingSegments,
  createPickedParentFolderAllowlist,
  createWorkspacePathGuard,
  isCanonicalPathContainedWithinCanonicalRoot,
  PathOutsideWorkspaceError,
  UnsafeRelativePathSegmentError,
} from '../workspace-path-guard';

/**
 * These tests run against a real temporary directory rather than a mocked `fs`, because the whole
 * point of the guard is what the *filesystem* does with symlinks and `..` — a mock would only
 * re-assert the implementation's own assumptions.
 */

let sandboxRootDirectory: string;
let registeredWorkspaceRoot: string;
let directoryOutsideEveryWorkspace: string;

beforeAll(async () => {
  // realpath the sandbox itself: on macOS `os.tmpdir()` is `/var/folders/...`, a symlink into
  // `/private/var`. Without this the "roots are canonicalized too" behaviour would be untested
  // because the expected values would already be canonical.
  sandboxRootDirectory = await realpath(await mkdtemp(join(tmpdir(), 'scratch-path-guard-')));

  registeredWorkspaceRoot = join(sandboxRootDirectory, 'workspaces', 'my-workspace');
  await mkdir(join(registeredWorkspaceRoot, '.scratch'), { recursive: true });
  await writeFile(join(registeredWorkspaceRoot, '.scratch', '.scratchmd'), 'workbook: {}\n');
  await mkdir(join(registeredWorkspaceRoot, 'airtable', 'Base', 'Table'), { recursive: true });
  await writeFile(join(registeredWorkspaceRoot, 'airtable', 'Base', 'Table', 'rec1.json'), '{}');

  directoryOutsideEveryWorkspace = join(sandboxRootDirectory, 'elsewhere');
  await mkdir(directoryOutsideEveryWorkspace, { recursive: true });
  await writeFile(join(directoryOutsideEveryWorkspace, 'credentials.yaml'), 'apiToken: secret\n');
});

afterAll(async () => {
  // Left in place deliberately — mkdtemp dirs are cleaned by the OS, and removing them here would
  // race the symlink assertions if a test failed midway.
});

function createGuardOverRegisteredWorkspace() {
  return createWorkspacePathGuard(() => Promise.resolve([registeredWorkspaceRoot]));
}

describe('isCanonicalPathContainedWithinCanonicalRoot', () => {
  it('accepts the root itself and paths beneath it', () => {
    // The root itself matters: "Reveal in Finder" and "Open in Terminal" pass the workspace root
    // exactly, so a `startsWith(root + sep)` check would break them.
    expect(isCanonicalPathContainedWithinCanonicalRoot('/home/me/work', '/home/me/work')).toBe(true);
    expect(isCanonicalPathContainedWithinCanonicalRoot('/home/me/work/a/b.json', '/home/me/work')).toBe(true);
    // `.scratch` is inside the workspace and legitimately reachable (views folder, workspace.log).
    expect(isCanonicalPathContainedWithinCanonicalRoot('/home/me/work/.scratch/schemas/t.json', '/home/me/work')).toBe(
      true,
    );
  });

  it('rejects a sibling directory that merely shares a string prefix', () => {
    // The bug a naive `startsWith` would have: `/home/me/work-evil` is not inside `/home/me/work`.
    expect(isCanonicalPathContainedWithinCanonicalRoot('/home/me/work-evil/x', '/home/me/work')).toBe(false);
    expect(isCanonicalPathContainedWithinCanonicalRoot('/home/me/workshop', '/home/me/work')).toBe(false);
  });

  it('rejects ancestors and unrelated paths', () => {
    expect(isCanonicalPathContainedWithinCanonicalRoot('/home/me', '/home/me/work')).toBe(false);
    expect(isCanonicalPathContainedWithinCanonicalRoot('/etc/passwd', '/home/me/work')).toBe(false);
  });
});

describe('canonicalizePathAllowingMissingTrailingSegments', () => {
  it('resolves an existing path through symlinks', async () => {
    const symlinkToWorkspace = join(sandboxRootDirectory, 'link-to-workspace');
    await symlink(registeredWorkspaceRoot, symlinkToWorkspace);
    expect(await canonicalizePathAllowingMissingTrailingSegments(symlinkToWorkspace)).toBe(registeredWorkspaceRoot);
  });

  it('resolves the existing ancestor of a file that does not exist yet', async () => {
    // The write case: `writeFileTextRaw` targets a file that may not exist, but every directory
    // above it does, and those are the components an attacker could have pointed elsewhere.
    const notYetCreatedFile = join(registeredWorkspaceRoot, 'airtable', 'Base', 'Table', 'brand-new.json');
    expect(await canonicalizePathAllowingMissingTrailingSegments(notYetCreatedFile)).toBe(notYetCreatedFile);
  });

  it('collapses .. before deciding anything', async () => {
    // <sandbox>/workspaces/my-workspace/airtable → up three → <sandbox> → elsewhere/
    const traversingPath = join(registeredWorkspaceRoot, 'airtable', '..', '..', '..', 'elsewhere', 'credentials.yaml');
    expect(await canonicalizePathAllowingMissingTrailingSegments(traversingPath)).toBe(
      join(directoryOutsideEveryWorkspace, 'credentials.yaml'),
    );
  });
});

describe('assertPathInsideRegisteredWorkspace', () => {
  it('allows the workspace root and files within it', async () => {
    const guard = createGuardOverRegisteredWorkspace();
    await expect(guard.assertPathInsideRegisteredWorkspace(registeredWorkspaceRoot)).resolves.toBe(
      registeredWorkspaceRoot,
    );
    const recordPath = join(registeredWorkspaceRoot, 'airtable', 'Base', 'Table', 'rec1.json');
    await expect(guard.assertPathInsideRegisteredWorkspace(recordPath)).resolves.toBe(recordPath);
  });

  it('allows a not-yet-created file inside the workspace so writes still work', async () => {
    const guard = createGuardOverRegisteredWorkspace();
    const newRecordPath = join(registeredWorkspaceRoot, 'airtable', 'Base', 'Table', 'unwritten.json');
    await expect(guard.assertPathInsideRegisteredWorkspace(newRecordPath)).resolves.toBe(newRecordPath);
  });

  it('rejects a path outside every registered workspace', async () => {
    const guard = createGuardOverRegisteredWorkspace();
    await expect(
      guard.assertPathInsideRegisteredWorkspace(join(directoryOutsideEveryWorkspace, 'credentials.yaml')),
    ).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  it('rejects .. traversal out of the workspace', async () => {
    // Oneleet's primitive: a workspace-looking path that walks out to somewhere sensitive.
    const guard = createGuardOverRegisteredWorkspace();
    await expect(
      guard.assertPathInsideRegisteredWorkspace(join(registeredWorkspaceRoot, '..', '..', 'elsewhere', 'x.json')),
    ).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  it('rejects a symlink inside the workspace that points out of it', async () => {
    // The case a string-prefix check cannot catch: the path looks like it is inside the workspace
    // at every character, but the filesystem sends the read somewhere else.
    const escapingSymlink = join(registeredWorkspaceRoot, 'escape-hatch');
    await symlink(directoryOutsideEveryWorkspace, escapingSymlink);
    const guard = createGuardOverRegisteredWorkspace();
    await expect(
      guard.assertPathInsideRegisteredWorkspace(join(escapingSymlink, 'credentials.yaml')),
    ).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  it('rejects relative paths, empty values, and NUL bytes', async () => {
    const guard = createGuardOverRegisteredWorkspace();
    await expect(guard.assertPathInsideRegisteredWorkspace('relative/path.json')).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
    await expect(guard.assertPathInsideRegisteredWorkspace('')).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
    await expect(
      guard.assertPathInsideRegisteredWorkspace(`${registeredWorkspaceRoot}/rec.json\0.png`),
    ).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  it('honours mustExist for reads', async () => {
    const guard = createGuardOverRegisteredWorkspace();
    await expect(
      guard.assertPathInsideRegisteredWorkspace(join(registeredWorkspaceRoot, 'nope.json'), { mustExist: true }),
    ).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  it('picks up a workspace registered after the root set was first cached', async () => {
    // Guards against the failure mode where creating a workspace mid-session makes every
    // subsequent read fail until the app restarts.
    let rootsVisibleToGuard: string[] = [];
    const guard = createWorkspacePathGuard(() => Promise.resolve(rootsVisibleToGuard));

    await expect(guard.assertPathInsideRegisteredWorkspace(registeredWorkspaceRoot)).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );

    rootsVisibleToGuard = [registeredWorkspaceRoot];
    await expect(guard.assertPathInsideRegisteredWorkspace(registeredWorkspaceRoot)).resolves.toBe(
      registeredWorkspaceRoot,
    );
  });

  it('tolerates a stale registry entry whose folder is gone', async () => {
    const guard = createWorkspacePathGuard(() =>
      Promise.resolve([join(sandboxRootDirectory, 'deleted-workspace'), registeredWorkspaceRoot]),
    );
    await expect(guard.assertPathInsideRegisteredWorkspace(registeredWorkspaceRoot)).resolves.toBe(
      registeredWorkspaceRoot,
    );
  });
});

describe('assertPathIsRegisteredWorkspaceRoot', () => {
  it('accepts a registered root', async () => {
    const guard = createGuardOverRegisteredWorkspace();
    await expect(guard.assertPathIsRegisteredWorkspaceRoot(registeredWorkspaceRoot)).resolves.toBe(
      registeredWorkspaceRoot,
    );
  });

  it('rejects a subdirectory of a registered root', async () => {
    // `workspacePath` is the base every downstream `relative()` containment check measures
    // against, so letting a caller re-root it would make those checks measure the wrong thing.
    const guard = createGuardOverRegisteredWorkspace();
    await expect(
      guard.assertPathIsRegisteredWorkspaceRoot(join(registeredWorkspaceRoot, 'airtable')),
    ).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
  });

  it('rejects / and other unrelated roots', async () => {
    // The specific bypass this closes: `workspacePath='/'` plus `folderPath='/etc'` satisfies
    // every existing `relative()`-based check downstream.
    const guard = createGuardOverRegisteredWorkspace();
    await expect(guard.assertPathIsRegisteredWorkspaceRoot('/')).rejects.toBeInstanceOf(PathOutsideWorkspaceError);
    await expect(guard.assertPathIsRegisteredWorkspaceRoot(directoryOutsideEveryWorkspace)).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
  });
});

describe('assertSafeWorkspaceRelativeFragment', () => {
  it('allows the nested connection-relative fragments the app really uses', () => {
    expect(assertSafeWorkspaceRelativeFragment('relPath', 'airtable/Base/Table')).toBe('airtable/Base/Table');
    expect(assertSafeWorkspaceRelativeFragment('relPath', 'Table')).toBe('Table');
  });

  it('rejects upward traversal, absolute values, and NUL bytes', () => {
    // `readConnectionSchema` joins this onto a valid workspace root, so confining the root alone
    // would not stop it.
    for (const unsafeFragment of ['../../../../etc', 'airtable/../../..', '/etc/passwd', '\\etc', 'a\0b', '']) {
      expect(() => assertSafeWorkspaceRelativeFragment('relPath', unsafeFragment)).toThrow(
        UnsafeRelativePathSegmentError,
      );
    }
  });

  it('rejects Windows drive-qualified values that escape without any ..', () => {
    expect(() => assertSafeWorkspaceRelativeFragment('relPath', 'C:evil')).toThrow(UnsafeRelativePathSegmentError);
    expect(() => assertSafeWorkspaceRelativeFragment('relPath', 'C:\\Windows')).toThrow(UnsafeRelativePathSegmentError);
  });

  it('treats backslash as a separator on every platform', () => {
    // The same string can reach a Windows and a macOS build; they must agree on what it means.
    expect(() => assertSafeWorkspaceRelativeFragment('relPath', 'airtable\\..\\..\\..')).toThrow(
      UnsafeRelativePathSegmentError,
    );
  });
});

describe('assertSafeSinglePathSegment', () => {
  it('allows an ordinary name', () => {
    expect(assertSafeSinglePathSegment('viewName', 'default')).toBe('default');
    expect(assertSafeSinglePathSegment('filename', 'rec1.json')).toBe('rec1.json');
  });

  it('rejects separators, because these are interpolated into a filename', () => {
    // `readConnectionView` builds `${viewName}.json`, so a separator alone redirects the read even
    // with no `..` anywhere in the value.
    expect(() => assertSafeSinglePathSegment('viewName', 'a/b')).toThrow(UnsafeRelativePathSegmentError);
    expect(() => assertSafeSinglePathSegment('folderName', '../../secret')).toThrow(UnsafeRelativePathSegmentError);
    expect(() => assertSafeSinglePathSegment('filename', 'sub\\rec.json')).toThrow(UnsafeRelativePathSegmentError);
  });

  it('rejects . as a name', () => {
    expect(() => assertSafeSinglePathSegment('viewName', '.')).toThrow(UnsafeRelativePathSegmentError);
  });
});

describe('createPickedParentFolderAllowlist', () => {
  it('accepts a folder the user picked in the native dialog', async () => {
    const allowlist = createPickedParentFolderAllowlist(() => Promise.resolve([]));
    await allowlist.rememberUserPickedParentFolder(sandboxRootDirectory);
    await expect(allowlist.assertParentFolderWasPickedByUser(sandboxRootDirectory)).resolves.toBe(sandboxRootDirectory);
  });

  it('rejects a folder the renderer invented', async () => {
    // Without this, `scratch:init-workspace` runs the CLI with an attacker-chosen working directory.
    const allowlist = createPickedParentFolderAllowlist(() => Promise.resolve([]));
    await expect(allowlist.assertParentFolderWasPickedByUser(directoryOutsideEveryWorkspace)).rejects.toBeInstanceOf(
      PathOutsideWorkspaceError,
    );
  });

  it('accepts the parent of an already-registered workspace so re-init still works', async () => {
    // `ReinitWorkspaceModal` derives the parent instead of re-prompting the user.
    const allowlist = createPickedParentFolderAllowlist(() => Promise.resolve([registeredWorkspaceRoot]));
    await expect(allowlist.assertParentFolderWasPickedByUser(join(sandboxRootDirectory, 'workspaces'))).resolves.toBe(
      join(sandboxRootDirectory, 'workspaces'),
    );
  });
});
