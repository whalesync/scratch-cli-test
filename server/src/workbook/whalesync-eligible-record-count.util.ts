/**
 * The record count Whalesync attributes to a CRM-bridge workspace's plan.
 *
 * A CRM bridge keeps the same records synced across its two connections, so a
 * given record exists as a file on BOTH sides — but the user thinks of it as one
 * record. To count it once we take the LARGER of the two connection sides rather
 * than summing them. Generalizes to however many connector accounts a workspace
 * has (one, two, or more) by taking the max per-connection sum; returns 0 when no
 * folder is linked to a connector account.
 *
 * Caller is responsible for restricting this to CRM-bridge workspaces
 * (`managedBy === ws_crm`); this helper only does the per-connection max.
 */
export function largestConnectionSideRecordCount(
  foldersWithConnectorAccountAndRecordCount: ReadonlyArray<{
    connectorAccountId: string | null;
    recordCount: number;
  }>,
): number {
  const recordCountByConnectorAccountId = new Map<string, number>();
  for (const folder of foldersWithConnectorAccountAndRecordCount) {
    if (!folder.connectorAccountId) continue;
    const runningTotalForConnectorAccount = recordCountByConnectorAccountId.get(folder.connectorAccountId) ?? 0;
    recordCountByConnectorAccountId.set(
      folder.connectorAccountId,
      runningTotalForConnectorAccount + folder.recordCount,
    );
  }

  let largestConnectionSide = 0;
  for (const connectionSideRecordCount of recordCountByConnectorAccountId.values()) {
    if (connectionSideRecordCount > largestConnectionSide) {
      largestConnectionSide = connectionSideRecordCount;
    }
  }
  return largestConnectionSide;
}
