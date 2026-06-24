import type { Service } from '../../enums/enums';

/**
 * Organization-wide usage summary for the billing page: how many workbooks the organization owns,
 * the total record count across all of them, and every connector service used by at least one data
 * folder. Org-scoped by `Workbook.organizationId` (NOT membership-scoped like the workspace list),
 * and excludes workbooks pending deletion. The counts are cheap aggregates over denormalized
 * columns, not live git walks. `connectorServices` includes services whose connection is broken or
 * disconnected — membership is by data folder, not by a live connection.
 */
export interface OrganizationUsageSummaryResponseDto {
  workbookCount: number;
  recordCount: number;
  /**
   * The record count attributed to the organization's Whalesync plan: summed across only its
   * CRM-bridge workspaces (`managedBy === ws_crm`), taking the LARGER of each workspace's two
   * connection sides rather than the sum. A CRM bridge syncs the same records across both
   * connections, so each record exists on both sides; the user thinks of it as one record, so it is
   * counted once per workspace (the bigger side). Non-CRM-bridge workspaces are excluded. This is
   * therefore <= `recordCount`.
   */
  whalesyncEligibleRecordCount: number;
  connectorServices: Service[];
}
