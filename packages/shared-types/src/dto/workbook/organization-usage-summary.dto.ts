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
  connectorServices: Service[];
}
