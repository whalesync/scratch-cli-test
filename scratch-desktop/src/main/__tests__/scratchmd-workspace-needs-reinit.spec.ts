// Locks down the wire-shape contract the desktop reads from any `scratchmd`
// call that refuses because the workspace was created on the pre-slice-F
// layout. The CLI prints a structured JSON payload on stdout in `--json`
// mode, or a human-readable banner without `--json`; either way the bail
// message lands on stderr. `parseWorkspaceNeedsReinitPayload` is the
// predicate `runScratchmdCapture` uses to decide whether to broadcast
// `WORKSPACE_NEEDS_REINIT_CHANNEL` to the renderer.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => '/fake' },
  BrowserWindow: { getAllWindows: () => [] },
}));

import { parseWorkspaceNeedsReinitPayload } from '../scratchmd';

describe('parseWorkspaceNeedsReinitPayload', () => {
  it('parses a CLI-shaped workspace_needs_reinit payload from stdout', () => {
    const stdout = JSON.stringify({
      status: 'workspace_needs_reinit',
      reason: 'old_layout_pre_slice_f',
      affectedConnections: ['HubSpot', 'Stripe'],
      connectionsWithMasterWorktree: ['HubSpot'],
      connectionsWithSparseCheckout: ['Stripe'],
      recommendation: 'Run `scratchmd workspaces init <workbook-id> --force` to reinitialize.',
    });
    const parsed = parseWorkspaceNeedsReinitPayload(stdout);
    expect(parsed).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.status).toBe('workspace_needs_reinit');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.affectedConnections).toEqual(['HubSpot', 'Stripe']);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.connectionsWithMasterWorktree).toEqual(['HubSpot']);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.connectionsWithSparseCheckout).toEqual(['Stripe']);
  });

  it('parses a DEV-9698 structure_changed payload and preserves its reason + recommendation', () => {
    // The folder-restructure re-clone signal: same envelope, different reason.
    // The renderer keys its copy off this reason, so it must survive the parse.
    const stdout = JSON.stringify({
      status: 'workspace_needs_reinit',
      reason: 'structure_changed',
      affectedConnections: ['Marketing Site'],
      recommendation:
        'The folder structure for these connection(s) changed on the server. Run `scratchmd workspaces init <workbook-id> --force` to re-sync your local copy. Edits staged for publish are backed up first; accept or publish any other in-progress changes before re-cloning to keep them.',
    });
    const parsed = parseWorkspaceNeedsReinitPayload(stdout);
    expect(parsed).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.reason).toBe('structure_changed');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.affectedConnections).toEqual(['Marketing Site']);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.recommendation).toContain('backed up first');
  });

  it('falls back to stderr marker detection when stdout is not JSON (non --json mode)', () => {
    const stdout = 'This workspace was created on an older version of Scratch and needs to be reinitialized.\n';
    const stderr = 'Error: This workspace was created on an older version of Scratch and needs to be reinitialized.\n';
    const parsed = parseWorkspaceNeedsReinitPayload(stdout, stderr);
    expect(parsed).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(parsed!.affectedConnections).toEqual([]);
  });

  it('returns null when there is no signal at all', () => {
    expect(parseWorkspaceNeedsReinitPayload('')).toBeNull();
    expect(parseWorkspaceNeedsReinitPayload('Error: connection refused\n', 'some unrelated noise')).toBeNull();
  });

  it('returns null for an unrelated structured payload (e.g. blocked_stale)', () => {
    const stdout = JSON.stringify({
      status: 'blocked_stale',
      blockedCount: 1,
      connections: [],
      elapsedMs: 100,
    });
    expect(parseWorkspaceNeedsReinitPayload(stdout)).toBeNull();
  });
});
