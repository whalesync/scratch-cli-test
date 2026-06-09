import { isNotEmpty } from '@/utils/helpers';
import { DataFolder, Service, Workspace } from '@spinner/shared-types';
import isBoolean from 'lodash/isBoolean';
import isNumber from 'lodash/isNumber';
import partition from 'lodash/partition';
import toNumber from 'lodash/toNumber';
import uniq from 'lodash/uniq';

export type RecordErrorsMetadata = {
  byField?: Record<string, { message: string; severity: 'warning' | 'error' }[]>;
};

export interface PullWorkbookResult {
  jobId: string;
}

export function getSafeBooleanValue(fields: Record<string, unknown>, columnId: string): boolean {
  const value = fields[columnId];
  if (value === null || value === undefined) {
    return false;
  }

  if (isBoolean(value)) {
    return value as boolean;
  }

  return new Boolean(value).valueOf();
}

export function getSafeNumberValue(
  fields: Record<string, unknown>,
  columnId: string,
  defaultValue?: number,
): number | undefined {
  const value = fields[columnId];
  if (value === null || value === undefined || value === '') {
    return defaultValue ?? undefined;
  }

  if (isNumber(value)) {
    return value as number;
  }

  return toNumber(value);
}

/**
 * Checks if all connections in a workbook are deleted.
 * Returns true if:
 * - The workbook has at least one snapshot table with a connector account
 * - All snapshot tables with connector accounts have a deleted connection.
 * Returns false otherwise.
 */
export function hasAllConnectionsDeleted(workbook: Workspace | undefined): boolean {
  if (!workbook) {
    return false;
  }
  if (workbook.dataFolders?.length === 0) {
    return false;
  }
  // Check if all tables have a deleted connection
  return (
    workbook.dataFolders?.every((folder) => folder.connectorAccountId === null && folder.connectorService !== null) ??
    false
  );
}

export function getConnectorsWithStatus(workbook: Workspace): { connectorService: Service; isBroken: boolean }[] {
  // Collect connector info from both snapshotTables and dataFolders
  const connectorSources = [
    ...(workbook.dataFolders ?? []).map((folder) => ({
      connectorService: folder.connectorService,
      connectorAccountId: folder.connectorAccountId,
    })),
  ];

  const [working, broken] = partition(connectorSources, (source) => source.connectorAccountId !== null);

  // Get rid of nulls
  let workingServices = working.map((source) => source.connectorService).filter(isNotEmpty);
  let brokenServices = broken.map((source) => source.connectorService).filter(isNotEmpty);
  // Make each unique.
  workingServices = uniq(workingServices);
  brokenServices = uniq(brokenServices);

  return [
    ...workingServices.map((connectorService) => ({ connectorService, isBroken: false })),
    ...brokenServices.map((connectorService) => ({ connectorService, isBroken: true })),
  ];
}

/**
 * Checks if a service is deleted in a workbook.
 * Returns true if:
 * - The workbook has at least one snapshot table with the given service
 * - All snapshot tables with the given service have a deleted connection.
 * Returns false otherwise.
 */
export function hasDeletedServiceConnection(workbook: Workspace | undefined, service: Service): boolean {
  if (!workbook) {
    return false;
  }
  return (
    workbook.dataFolders
      ?.filter((folder) => folder.connectorService === service)
      .every((folder) => hasDeletedConnection(folder)) ?? false
  );
}

/**
 * Checks if a snapshot table has a connection deleted.
 * A deleted connection is when the connector account was removed but the table still exists.
 * This is indicated by connectorAccountId being null while connectorService is not null.
 */
export function hasDeletedConnection(folder: DataFolder): boolean {
  return folder.connectorAccountId === null && folder.connectorService !== null;
}
