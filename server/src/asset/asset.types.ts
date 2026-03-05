import { Service } from '@spinner/shared-types';

/** Context describing where the asset appears within the record. */
export type AssetContext = 'FIELD_VALUE' | 'CONTENT_BLOCK' | 'RECORD_PROPERTY' | 'STANDALONE_ENTITY';

/** High-level media type classification. */
export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'file' | 'external_video' | 'model_3d';

/** Asset metadata returned by a connector after uploading a file. */
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
  recordFilePath: string;
  recordRemoteId?: string;
  fieldPath?: string;
  assetContext: AssetContext;
}

/** Input for the asset extractor. */
export interface AssetExtractionInput {
  workbookId: string;
  service: Service;
  recordFilePath: string;
  recordRemoteId?: string;
  recordContent: Record<string, unknown>;
  schema: Record<string, unknown>;
}
