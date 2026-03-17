import { Service } from 'src/types/shared-types';

/** High-level media type classification. */
export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'file' | 'external_video' | 'model_3d';

/** Asset metadata returned by a connector (upload or extraction). */
export interface ConnectorAssetResult {
  remoteAssetId: string;
  url?: string;
  filename?: string;
  mimeType?: string;
  size?: number;
  width?: number;
  height?: number;
  altText?: string;
  mediaType?: MediaType;
  urlExpiresAt?: Date;
}

/** A single asset entry ready to be upserted into the Asset table. */
export interface AssetIndexEntry extends ConnectorAssetResult {
  workbookId: string;
  service: Service;
  dataFolderId?: string;
}

/** Input for connector-level asset extraction. */
export interface ConnectorAssetExtractionInput {
  recordContent: Record<string, unknown>;
  schema: Record<string, unknown>;
  recordRemoteId?: string;
}

/** Input for the asset extractor service (adds workbook/folder context). */
export interface AssetExtractionInput extends ConnectorAssetExtractionInput {
  workbookId: string;
  service: Service;
  dataFolderId?: string;
  recordFilePath: string;
}
