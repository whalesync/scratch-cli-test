import type { DataFolderId, WorkbookId } from '../ids';

/// Keep this in sync with the server/prisma/schema.prisma Asset model.

/**
 * A file/media asset extracted from record files during pull. Served by the
 * dev-tools asset-index endpoint (`GET /workbook/:workbookId/publish-v2/index/assets`).
 *
 * `size` is a `BigInt` column in Postgres; the server maps it to a plain number
 * before it crosses the wire (byte counts stay well within Number's safe range).
 */
export interface Asset {
  id: string;
  createdAt: string;
  updatedAt: string;
  workbookId: WorkbookId;
  dataFolderId: DataFolderId | null;
  service: string;
  remoteAssetId: string;
  url: string | null;
  filename: string | null;
  mimeType: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  altText: string | null;
  mediaType: string | null;
  urlExpiresAt: string | null;
  lastSeenAt: string | null;
  rehostedUrl: string | null;
  rehostedAt: string | null;
  contentHash: string | null;
  uploadedAt: string | null;
  sourceAssetId: string | null;
}
