import type { ReviewStat } from '../../../../shared/review-types';

/** One data folder's contribution to the pending-publish total, within a connection. */
export interface ApprovedPublishFolderBreakdown {
  folderPath: string;
  count: number;
}

/** Per-connection rollup of records approved but not yet published, with its folders. */
export interface ApprovedPublishConnectionBreakdown {
  connection: string;
  total: number;
  folders: ApprovedPublishFolderBreakdown[];
}

/**
 * Groups the per-folder review stats into a connection → data-folder breakdown of
 * records that are approved but not yet published (the set "Publish all" will ship).
 *
 * Only folders with at least one approved change are included. Connections are
 * ordered by descending approved total (ties broken alphabetically), and folders
 * within a connection likewise — so the heaviest pending work reads first.
 */
export function buildApprovedPublishBreakdown(stats: ReviewStat[]): ApprovedPublishConnectionBreakdown[] {
  const foldersByConnection = new Map<string, ApprovedPublishFolderBreakdown[]>();
  for (const stat of stats) {
    if (stat.approved <= 0) continue;
    const folder: ApprovedPublishFolderBreakdown = { folderPath: stat.folder_path, count: stat.approved };
    const existing = foldersByConnection.get(stat.connection);
    if (existing) {
      existing.push(folder);
    } else {
      foldersByConnection.set(stat.connection, [folder]);
    }
  }

  const breakdown: ApprovedPublishConnectionBreakdown[] = [];
  foldersByConnection.forEach((folders, connection) => {
    folders.sort((a, b) => b.count - a.count || a.folderPath.localeCompare(b.folderPath));
    const total = folders.reduce((sum, folder) => sum + folder.count, 0);
    breakdown.push({ connection, total, folders });
  });
  breakdown.sort((a, b) => b.total - a.total || a.connection.localeCompare(b.connection));
  return breakdown;
}
