/**
 * DEV-10413 — single-record publish target resolution (pure-logic tests).
 *
 * The path round-trip is the load-bearing bit: `relPath` must be the
 * connection-relative path with NO leading slash (the publish plan's `filePath`
 * scope), while `filePath` stays workspace-relative for the CLI, and
 * `folderPath` is absolute for the scoped validation check. A mismatch here
 * silently scopes the plan to nothing (false "nothing to publish").
 */

import { describe, expect, it } from 'vitest';
import { resolveSingleRecordPublishTarget } from '../single-record-publish-target';

const connections = [
  { id: 'ca_airtable', dirName: 'My Airtable' },
  { id: 'ca_webflow', dirName: 'Webflow Site' },
];

describe('resolveSingleRecordPublishTarget', () => {
  it('resolves a nested record path into a fully-scoped target', () => {
    const result = resolveSingleRecordPublishTarget(
      '/Users/me/ws',
      'Webflow Site/Collections/Posts/rec_1.json',
      connections,
    );
    expect(result).toEqual({
      ok: true,
      target: {
        filePath: 'Webflow Site/Collections/Posts/rec_1.json',
        relPath: 'Collections/Posts/rec_1.json',
        connectionId: 'ca_webflow',
        connectionName: 'Webflow Site',
        folderPath: '/Users/me/ws/Webflow Site/Collections/Posts',
        filename: 'rec_1.json',
      },
    });
  });

  it('keeps relPath connection-relative with no leading slash (path round-trip)', () => {
    const result = resolveSingleRecordPublishTarget('/ws', 'My Airtable/Companies/rec_42.json', connections);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // relPath drops the connection segment and never carries a leading slash.
    expect(result.target.relPath).toBe('Companies/rec_42.json');
    expect(result.target.relPath.startsWith('/')).toBe(false);
    // filePath keeps the connection segment for the CLI.
    expect(result.target.filePath).toBe('My Airtable/Companies/rec_42.json');
  });

  it('tolerates a leading slash on the input', () => {
    const result = resolveSingleRecordPublishTarget('/ws', '/My Airtable/Companies/rec_42.json', connections);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.filePath).toBe('My Airtable/Companies/rec_42.json');
    expect(result.target.connectionId).toBe('ca_airtable');
  });

  it('resolves a record directly under the connection root', () => {
    const result = resolveSingleRecordPublishTarget('/ws', 'My Airtable/rec_1.json', connections);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.target.relPath).toBe('rec_1.json');
    expect(result.target.folderPath).toBe('/ws/My Airtable');
  });

  it('errors when the first segment matches no connection', () => {
    const result = resolveSingleRecordPublishTarget('/ws', 'Unknown Conn/Posts/rec_1.json', connections);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('No connection matches');
  });

  it('errors on a malformed path with no connection segment', () => {
    const result = resolveSingleRecordPublishTarget('/ws', 'rec_1.json', connections);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('Unexpected record path');
  });
});
