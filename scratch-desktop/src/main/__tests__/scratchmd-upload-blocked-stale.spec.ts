// DEV-10144 D8: locks down the wire-shape contract the desktop reads from
// `scratchmd --json files upload` when the CLI refuses with the structured
// `blocked_stale` payload (server's refs/heads/main advanced past local).
//
// The CLI prints the payload to stdout AND exits non-zero, so the desktop's
// `uploadWorkspaceChanges` wrapper has to recognize it specifically rather
// than falling into the generic error path. `parseBlockedStalePayload` is
// the predicate that drives that branch.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/fake' } }));

import { parseBlockedStalePayload } from '../scratchmd';

describe('parseBlockedStalePayload', () => {
  it('parses a CLI-shaped blocked_stale payload', () => {
    const stdout = JSON.stringify({
      status: 'blocked_stale',
      blockedCount: 1,
      connections: [
        {
          connectionName: 'HubSpot',
          baseHead: 'a'.repeat(40),
          currentRemoteHead: 'b'.repeat(40),
          message: 'Server `main` has advanced past your local `main`.',
        },
      ],
      elapsedMs: 1234,
    });
    const parsed = parseBlockedStalePayload(stdout);
    expect(parsed).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.status).toBe('blocked_stale');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.blockedCount).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.connections[0].connectionName).toBe('HubSpot');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.connections[0].currentRemoteHead).toBe('b'.repeat(40));
  });

  it('returns null for the successful upload payload (so the success path keeps using it)', () => {
    const stdout = JSON.stringify({
      status: 'uploaded',
      filesCreated: 1,
      filesUpdated: 0,
      filesDeleted: 0,
      createdPaths: ['HubSpot/Companies/rec_1.json'],
      updatedPaths: [],
      deletedPaths: [],
      messages: [],
      stalenessWarning: null,
      connections: [],
      elapsedMs: 100,
    });
    expect(parseBlockedStalePayload(stdout)).toBeNull();
  });

  it('returns null when stdout is not JSON (random stderr leak, debug noise)', () => {
    expect(parseBlockedStalePayload('Error: connection refused\n')).toBeNull();
    expect(parseBlockedStalePayload('')).toBeNull();
  });

  it('returns null when the shape is JSON but status is unknown', () => {
    const stdout = JSON.stringify({ status: 'something_else', connections: [] });
    expect(parseBlockedStalePayload(stdout)).toBeNull();
  });

  it('returns null when status is correct but connections is missing or wrong type', () => {
    expect(parseBlockedStalePayload(JSON.stringify({ status: 'blocked_stale' }))).toBeNull();
    expect(parseBlockedStalePayload(JSON.stringify({ status: 'blocked_stale', connections: 'oops' }))).toBeNull();
  });
});
