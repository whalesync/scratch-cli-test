import { z } from 'zod';
import type { DataFolderId } from '../../ids';

/**
 * Request to re-derive the schema (JSON table spec + default view) for every data folder
 * belonging to a single connection (connector account), in one call.
 */
export const refreshConnectionSchemasSchema = z.object({
  connectorAccountId: z.string().min(1),
});

export type RefreshConnectionSchemasDto = z.infer<typeof refreshConnectionSchemasSchema>;

/** Per-folder outcome of a connection-wide schema refresh. */
export interface RefreshConnectionSchemasResult {
  dataFolderId: DataFolderId;
  folderName: string;
  status: 'refreshed' | 'failed';
  /** Present when `status === 'failed'`. */
  error?: string;
}

/** Aggregate result of refreshing every data folder's schema in a connection. */
export interface RefreshConnectionSchemasResponse {
  refreshedCount: number;
  failedCount: number;
  results: RefreshConnectionSchemasResult[];
}
