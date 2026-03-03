import { Service } from '@spinner/shared-types';

/** Context describing where the asset appears within the record. */
export type AssetContext = 'FIELD_VALUE' | 'CONTENT_BLOCK' | 'RECORD_PROPERTY' | 'STANDALONE_ENTITY';

/** High-level media type classification. */
export type MediaType = 'image' | 'video' | 'audio' | 'document' | 'file' | 'external_video' | 'model_3d';

/** A single asset entry ready to be upserted into the Asset table. */
export interface AssetIndexEntry {
  workbookId: string;
  service: Service;
  remoteAssetId: string;
  recordFilePath: string;
  recordRemoteId?: string;
  fieldPath?: string;
  assetContext: AssetContext;
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

/** Input for the asset extractor. */
export interface AssetExtractionInput {
  workbookId: string;
  service: Service;
  recordFilePath: string;
  recordRemoteId?: string;
  recordContent: Record<string, unknown>;
  schema: Record<string, unknown>;
}
