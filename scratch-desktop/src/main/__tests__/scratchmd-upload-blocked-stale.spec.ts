// DEV-10144 D8 + DEV-10316: locks down the wire-shape contract the desktop
// reads from `scratchmd --json files upload` when the CLI refuses with a
// structured payload — `blocked_stale` (server's refs/heads/main advanced past
// local), `blocked_dirty` (the connection has unpublished server changes), or
// `check_failed` (the dirty-gate check couldn't run, retryable).
//
// The CLI prints the payload to stdout AND exits non-zero, so the desktop's
// `uploadWorkspaceChanges` wrapper has to recognize it specifically rather than
// falling into the generic error path. `parseUploadRefusalPayload` is the
// predicate that drives that branch.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/fake' } }));

import { parseUploadRefusalPayload } from '../scratchmd';

describe('parseUploadRefusalPayload', () => {
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
    const parsed = parseUploadRefusalPayload(stdout);
    expect(parsed).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.status).toBe('blocked_stale');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.blockedCount).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.connections[0].connectionName).toBe('HubSpot');
  });

  it('parses a CLI-shaped blocked_dirty payload (DEV-10316, count-only)', () => {
    const stdout = JSON.stringify({
      status: 'blocked_dirty',
      blockedCount: 2,
      connections: [
        { connectionName: 'Airtable · CRM', connectorAccountId: 'ca_1', dirtyCount: 47 },
        { connectionName: 'Webflow · Blog', connectorAccountId: 'ca_2', dirtyCount: 12 },
      ],
      elapsedMs: 800,
    });
    const parsed = parseUploadRefusalPayload(stdout);
    expect(parsed).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.status).toBe('blocked_dirty');
    // narrow for field access
    if (parsed?.status !== 'blocked_dirty') throw new Error('expected blocked_dirty');
    expect(parsed.blockedCount).toBe(2);
    expect(parsed.connections[0].connectionName).toBe('Airtable · CRM');
    expect(parsed.connections[0].dirtyCount).toBe(47);
    expect(parsed.connections[1].connectorAccountId).toBe('ca_2');
  });

  it('parses a CLI-shaped check_failed payload (DEV-10316, fail-closed retryable)', () => {
    const stdout = JSON.stringify({
      status: 'check_failed',
      blockedCount: 1,
      connections: [{ connectionName: 'Notion · Docs', connectorAccountId: 'ca_3', message: 'git service busy' }],
      message: "Couldn't verify the server's state. Try again.",
      elapsedMs: 30000,
    });
    const parsed = parseUploadRefusalPayload(stdout);
    expect(parsed).not.toBeNull();
    if (parsed?.status !== 'check_failed') throw new Error('expected check_failed');
    expect(parsed.connections[0].connectionName).toBe('Notion · Docs');
    expect(parsed.message).toContain('Try again');
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
    expect(parseUploadRefusalPayload(stdout)).toBeNull();
  });

  it('returns null when stdout is not JSON (random stderr leak, debug noise)', () => {
    expect(parseUploadRefusalPayload('Error: connection refused\n')).toBeNull();
    expect(parseUploadRefusalPayload('')).toBeNull();
  });

  it('returns null when the shape is JSON but status is unknown', () => {
    const stdout = JSON.stringify({ status: 'something_else', connections: [] });
    expect(parseUploadRefusalPayload(stdout)).toBeNull();
  });

  it('returns null when status is a refusal but connections is missing or wrong type', () => {
    expect(parseUploadRefusalPayload(JSON.stringify({ status: 'blocked_stale' }))).toBeNull();
    expect(parseUploadRefusalPayload(JSON.stringify({ status: 'blocked_dirty', connections: 'oops' }))).toBeNull();
    expect(parseUploadRefusalPayload(JSON.stringify({ status: 'check_failed' }))).toBeNull();
  });
});
