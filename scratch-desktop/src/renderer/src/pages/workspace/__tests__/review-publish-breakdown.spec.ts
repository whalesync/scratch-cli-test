import { describe, expect, it } from 'vitest';
import type { ReviewStat } from '../../../../../shared/review-types';
import { buildApprovedPublishBreakdown } from '../review-publish-breakdown';

function stat(connection: string, folderPath: string, unreviewed: number, approved: number): ReviewStat {
  return { connection, folder_path: folderPath, unreviewed, approved };
}

describe('buildApprovedPublishBreakdown', () => {
  it('returns an empty breakdown when nothing is approved', () => {
    expect(buildApprovedPublishBreakdown([])).toEqual([]);
    expect(buildApprovedPublishBreakdown([stat('Airtable', 'Companies', 3, 0)])).toEqual([]);
  });

  it('groups approved counts by connection then data folder, ignoring unreviewed-only folders', () => {
    const breakdown = buildApprovedPublishBreakdown([
      stat('Airtable', 'Companies', 5, 2),
      stat('Airtable', 'People', 0, 3),
      stat('Airtable', 'Empty', 4, 0), // approved 0 → excluded
      stat('Webflow', 'Posts', 1, 1),
    ]);

    expect(breakdown).toEqual([
      {
        connection: 'Airtable',
        total: 5,
        folders: [
          { folderPath: 'People', count: 3 },
          { folderPath: 'Companies', count: 2 },
        ],
      },
      {
        connection: 'Webflow',
        total: 1,
        folders: [{ folderPath: 'Posts', count: 1 }],
      },
    ]);
  });

  it('orders connections by descending approved total, ties broken alphabetically', () => {
    const breakdown = buildApprovedPublishBreakdown([
      stat('Zeta', 'A', 0, 2),
      stat('Alpha', 'A', 0, 2),
      stat('Beta', 'A', 0, 9),
    ]);
    expect(breakdown.map((c) => c.connection)).toEqual(['Beta', 'Alpha', 'Zeta']);
  });
});
