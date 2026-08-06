import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';
import { APP_QUIT_CONFIRMED_CHANNEL } from '../../shared/lifecycle-events';
import {
  createPathConfinedIpcRegistrar,
  NO_PATH_ARGUMENTS,
  type IpcPathConfinementDependencies,
  type PathArgumentPolicy,
} from '../ipc-path-confinement';
import { IPC_PATH_ARGUMENT_POLICIES } from '../ipc-path-policies';

/** Stand-in for the real guard: accepts anything under `/ws`, rejects everything else. */
function createStubDependencies(): IpcPathConfinementDependencies {
  const confineToStubWorkspace = (candidatePath: string): Promise<string> => {
    if (!candidatePath.startsWith('/ws')) {
      return Promise.reject(new Error(`outside workspace: ${candidatePath}`));
    }
    return Promise.resolve(candidatePath);
  };

  return {
    workspacePathGuard: {
      assertPathInsideRegisteredWorkspace: vi.fn(confineToStubWorkspace),
      assertPathIsRegisteredWorkspaceRoot: vi.fn((candidatePath: string) =>
        candidatePath === '/ws' ? Promise.resolve('/ws') : Promise.reject(new Error('not a root')),
      ),
      invalidateCachedWorkspaceRoots: vi.fn(),
    },
    pickedParentFolderAllowlist: {
      rememberUserPickedParentFolder: vi.fn(() => Promise.resolve()),
      assertParentFolderWasPickedByUser: vi.fn(confineToStubWorkspace),
    },
  };
}

/** Minimal `ipcMain` double capturing the wrapped listener so tests can invoke it directly. */
function createIpcMainDouble() {
  const registeredHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
  return {
    registeredHandlers,
    ipcMain: {
      handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        registeredHandlers.set(channel, listener);
      },
      on: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        registeredHandlers.set(channel, listener);
      },
      once: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => {
        registeredHandlers.set(channel, listener);
      },
    },
  };
}

function createRegistrarOverPolicies(policies: Record<string, readonly PathArgumentPolicy[]>) {
  const { ipcMain, registeredHandlers } = createIpcMainDouble();
  const dependencies = createStubDependencies();
  // The double implements only the three methods the registrar uses.
  const registrar = createPathConfinedIpcRegistrar(
    ipcMain as unknown as Parameters<typeof createPathConfinedIpcRegistrar>[0],
    policies,
    dependencies,
  );
  return { registrar, registeredHandlers, dependencies };
}

describe('createPathConfinedIpcRegistrar', () => {
  it('refuses to register a channel with no policy entry', () => {
    // The core property: an unconfined channel cannot reach production, because forgetting to
    // declare a policy is a startup crash rather than a silent hole.
    const { registrar } = createRegistrarOverPolicies({});
    expect(() => registrar.handle('files:brand-new-channel', () => undefined)).toThrow(/has no path-argument policy/);
  });

  it('lets a channel through once it declares NO_PATH_ARGUMENTS', () => {
    const { registrar } = createRegistrarOverPolicies({ 'files:harmless': NO_PATH_ARGUMENTS });
    expect(() => registrar.handle('files:harmless', () => undefined)).not.toThrow();
  });

  it('rejects a path outside the workspace before the handler body runs', async () => {
    const handlerBody = vi.fn(() => 'should not run');
    const { registrar, registeredHandlers } = createRegistrarOverPolicies({
      'files:read-file-text-raw': [{ kind: 'pathInsideRegisteredWorkspace', argumentIndex: 0 }],
    });
    registrar.handle('files:read-file-text-raw', handlerBody);

    const wrappedListener = registeredHandlers.get('files:read-file-text-raw');
    await expect(wrappedListener?.({}, '/etc/passwd')).rejects.toThrow(/outside workspace/);
    // The important half: the read never happened.
    expect(handlerBody).not.toHaveBeenCalled();
  });

  it('passes an accepted path through to the handler unmodified', async () => {
    // Absolute paths are an identity the renderer compares by string (folder-tree state, and
    // `workspaceRelativePosixPath`'s prefix match). Substituting the canonical form here makes the
    // two sides disagree on macOS (`/var` vs `/private/var`), which silently turns approving a
    // record into a no-op — caught by e2e/accept-record-regression.spec.ts.
    const handlerBody = vi.fn((_event: unknown, filePath: string) => filePath);
    const { registrar, registeredHandlers, dependencies } = createRegistrarOverPolicies({
      'files:read-file': [{ kind: 'pathInsideRegisteredWorkspace', argumentIndex: 0 }],
    });
    dependencies.workspacePathGuard.assertPathInsideRegisteredWorkspace = () => Promise.resolve('/ws/canonical.json');
    registrar.handle('files:read-file', handlerBody as never);

    await registeredHandlers.get('files:read-file')?.({}, '/ws/link.json');
    expect(handlerBody).toHaveBeenCalledWith({}, '/ws/link.json');
  });

  it('validates a path nested inside an options object', async () => {
    const handlerBody = vi.fn();
    const { registrar, registeredHandlers } = createRegistrarOverPolicies({
      'scratch:rerun-validation': [
        { kind: 'pathInsideRegisteredWorkspace', argumentIndex: 1, propertyPath: ['folderPath'], optional: true },
      ],
    });
    registrar.handle('scratch:rerun-validation', handlerBody);

    const wrappedListener = registeredHandlers.get('scratch:rerun-validation');
    await expect(wrappedListener?.({}, '/ws', { folderPath: '/etc' })).rejects.toThrow(/outside workspace/);
    expect(handlerBody).not.toHaveBeenCalled();
  });

  it('lets an absent optional path through untouched', async () => {
    const handlerBody = vi.fn();
    const { registrar, registeredHandlers } = createRegistrarOverPolicies({
      'scratch:accept-all-changes': [{ kind: 'pathInsideRegisteredWorkspace', argumentIndex: 1, optional: true }],
    });
    registrar.handle('scratch:accept-all-changes', handlerBody);

    await registeredHandlers.get('scratch:accept-all-changes')?.({}, '/ws', undefined);
    expect(handlerBody).toHaveBeenCalled();
  });

  it('rejects a traversing relative fragment even when the workspace root is valid', async () => {
    // The second half of SCR-007: `readConnectionSchema` joins this onto a legitimate root.
    const handlerBody = vi.fn();
    const { registrar, registeredHandlers } = createRegistrarOverPolicies({
      'files:read-connection-schema': [
        { kind: 'registeredWorkspaceRoot', argumentIndex: 0 },
        { kind: 'workspaceRelativeFragment', argumentIndex: 1 },
      ],
    });
    registrar.handle('files:read-connection-schema', handlerBody);

    const wrappedListener = registeredHandlers.get('files:read-connection-schema');
    await expect(wrappedListener?.({}, '/ws', '../../../../etc')).rejects.toThrow(/must not traverse upward/);
    expect(handlerBody).not.toHaveBeenCalled();
  });

  it('drops a rejected fire-and-forget send instead of raising an unhandled rejection', async () => {
    // `ipcMain.on` channels have no reply path, so a rejection has nowhere to go.
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlerBody = vi.fn();
    const { registrar, registeredHandlers } = createRegistrarOverPolicies({
      'scratch:log-api-call': [{ kind: 'registeredWorkspaceRoot', argumentIndex: 0 }],
    });
    registrar.on('scratch:log-api-call', handlerBody);

    registeredHandlers.get('scratch:log-api-call')?.({}, '/etc', {});
    await new Promise((resolve) => setImmediate(resolve));

    expect(handlerBody).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('IPC_PATH_ARGUMENT_POLICIES coverage', () => {
  /**
   * The registrar already fails closed, but only when the app boots. This test moves that failure
   * into CI by reading the channels straight out of `index.ts`, so adding a handler without a
   * policy breaks the build rather than the shipped app.
   */
  const indexSource = readFileSync(join(__dirname, '..', 'index.ts'), 'utf8');
  const registeredChannelNames: string[] = [];
  const channelRegistrationPattern = /confinedIpc\.(?:handle|on|once)\(\s*'([^']+)'/g;
  for (let match = channelRegistrationPattern.exec(indexSource); match !== null; ) {
    const channelName = match[1];
    if (channelName !== undefined) {
      registeredChannelNames.push(channelName);
    }
    match = channelRegistrationPattern.exec(indexSource);
  }

  it('finds the handlers in index.ts (guards against the regex silently matching nothing)', () => {
    expect(registeredChannelNames.length).toBeGreaterThan(70);
  });

  it('declares a policy for every channel registered in index.ts', () => {
    const channelsMissingAPolicy = registeredChannelNames.filter(
      (channelName) => IPC_PATH_ARGUMENT_POLICIES[channelName] === undefined,
    );
    expect(channelsMissingAPolicy).toEqual([]);
  });

  it('does not carry policies for channels that no longer exist', () => {
    // Constant-named channels (e.g. APP_QUIT_CONFIRMED_CHANNEL) are not string literals in the
    // source, so exclude them from the staleness check rather than matching on their values.
    const channelsRegisteredByConstant = new Set([APP_QUIT_CONFIRMED_CHANNEL]);
    const registeredChannelNameSet = new Set(registeredChannelNames);
    const stalePolicyChannels = Object.keys(IPC_PATH_ARGUMENT_POLICIES).filter(
      (channelName) => !registeredChannelNameSet.has(channelName) && !channelsRegisteredByConstant.has(channelName),
    );
    expect(stalePolicyChannels).toEqual([]);
  });
});
