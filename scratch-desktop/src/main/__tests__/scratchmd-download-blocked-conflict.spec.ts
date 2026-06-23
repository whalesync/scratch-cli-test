// DEV-10523: locks down the wire-shape contract the desktop reads from
// `scratchmd --json files download` when the CLI refuses with a structured
// `blocked_conflict` payload — an unreviewed local edit couldn't be re-applied
// after the pull (the server deleted the edited record, or the patch failed to
// reconstruct) and was saved to `unreviewed-changes.json`.
//
// The CLI prints the payload to stdout AND exits non-zero, so the desktop's
// `pullWorkspaceChanges` wrapper recognizes it specifically rather than falling
// into the generic error path. `parseDownloadRefusalPayload` is the predicate
// that drives that branch.

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/fake' } }));

import { parseDownloadRefusalPayload } from '../scratchmd';

describe('parseDownloadRefusalPayload', () => {
  it('parses a CLI-shaped blocked_conflict payload', () => {
    const stdout = JSON.stringify({
      status: 'blocked_conflict',
      conflictCount: 1,
      paths: ['HubSpot/Companies/rec_1.json'],
      stashFiles: ['.scratch/connections/scratch/HubSpot/unreviewed-changes.json'],
      elapsedMs: 1234,
    });
    const parsed = parseDownloadRefusalPayload(stdout);
    expect(parsed).not.toBeNull();
    if (parsed?.status !== 'blocked_conflict') throw new Error('expected blocked_conflict');
    expect(parsed.conflictCount).toBe(1);
    expect(parsed.paths[0]).toBe('HubSpot/Companies/rec_1.json');
    expect(parsed.stashFiles[0]).toContain('unreviewed-changes.json');
  });

  it('returns null for a successful download payload (so the success path keeps using it)', () => {
    const stdout = JSON.stringify({
      status: 'downloaded',
      filesCreated: 1,
      filesUpdated: 2,
      filesDeleted: 0,
      filesMerged: 0,
      conflictsAutoResolved: 0,
      unreviewedConflictsAutoResolved: 1,
      messages: [],
      elapsedMs: 100,
    });
    expect(parseDownloadRefusalPayload(stdout)).toBeNull();
  });

  it('returns null for the non-blocking downloaded_with_stashed_conflicts status (not a refusal)', () => {
    const stdout = JSON.stringify({
      status: 'downloaded_with_stashed_conflicts',
      filesCreated: 0,
      filesUpdated: 1,
      filesDeleted: 0,
      filesMerged: 0,
      conflictsAutoResolved: 0,
      unreviewedConflictsAutoResolved: 0,
      stashedConflictPaths: ['Airtable/posts/other.json'],
      stashFiles: ['.scratch/connections/scratch/Airtable/unreviewed-changes.json'],
      messages: [],
      elapsedMs: 100,
    });
    expect(parseDownloadRefusalPayload(stdout)).toBeNull();
  });

  it('returns null when stdout is not JSON (random stderr leak, debug noise)', () => {
    expect(parseDownloadRefusalPayload('Error: connection refused\n')).toBeNull();
    expect(parseDownloadRefusalPayload('')).toBeNull();
  });

  it('returns null when status is blocked_conflict but paths is missing or wrong type', () => {
    expect(parseDownloadRefusalPayload(JSON.stringify({ status: 'blocked_conflict' }))).toBeNull();
    expect(parseDownloadRefusalPayload(JSON.stringify({ status: 'blocked_conflict', paths: 'oops' }))).toBeNull();
  });

  it('returns null when the shape is JSON but status is unknown', () => {
    expect(parseDownloadRefusalPayload(JSON.stringify({ status: 'something_else', paths: [] }))).toBeNull();
  });
});
