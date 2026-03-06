import { Injectable } from '@nestjs/common';
import { Service } from '@spinner/shared-types';
import { createHash } from 'crypto';
import { get } from 'lodash';
import {
  ASSET_FIELD,
  ASSET_TABLE,
  AssetFieldOptions,
  AssetTableOptions,
} from '../remote-service/connectors/json-schema';
import { AssetExtractionInput, AssetIndexEntry, MediaType } from './asset.types';

/**
 * Extracts asset metadata from record file content using the table schema annotations.
 *
 * Two extraction phases:
 * 1. Schema-driven: Walk schema properties for `x-scratch-asset-field` annotations.
 *    Top-level properties (cover, icon, heroImage) get `RECORD_PROPERTY` context.
 * 2. Content blocks: Walk page_content (Notion) and richContent.nodes (Wix) for media blocks.
 */
@Injectable()
export class AssetExtractorService {
  extractAssets(input: AssetExtractionInput): AssetIndexEntry[] {
    const entries: AssetIndexEntry[] = [];
    const seen = new Set<string>();

    const addEntry = (entry: AssetIndexEntry) => {
      if (!seen.has(entry.remoteAssetId)) {
        seen.add(entry.remoteAssetId);
        entries.push(entry);
      }
    };

    // Phase 0: Standalone entity — the entire record IS an asset
    const standaloneEntry = this.extractStandaloneEntity(input);
    if (standaloneEntry) {
      addEntry(standaloneEntry);
      return entries;
    }

    // Phase 1: Schema-driven extraction
    this.extractFromSchema(input, addEntry);

    // Phase 2: Content blocks
    this.extractFromContentBlocks(input, addEntry);

    return entries;
  }

  /** Phase 0: If the schema has `x-scratch-asset-table`, treat the entire record as a standalone asset. */
  private extractStandaloneEntity(input: AssetExtractionInput): AssetIndexEntry | null {
    const opts = input.schema[ASSET_TABLE] as AssetTableOptions | undefined;
    if (!opts) return null;

    const url = get(input.recordContent, opts.urlPath) as string | undefined;
    if (!url || typeof url !== 'string') return null;

    const remoteAssetId = input.recordRemoteId ?? this.hashUrl(url);
    const mimeType = opts.mimeTypePath
      ? (get(input.recordContent, opts.mimeTypePath) as string | undefined)
      : undefined;

    const rawSize = opts.sizePath ? get(input.recordContent, opts.sizePath) : undefined;
    const rawWidth = opts.widthPath ? get(input.recordContent, opts.widthPath) : undefined;
    const rawHeight = opts.heightPath ? get(input.recordContent, opts.heightPath) : undefined;

    return {
      workbookId: input.workbookId,
      service: input.service,
      remoteAssetId,
      dataFolderId: input.dataFolderId,
      url,
      filename: opts.filenamePath ? (get(input.recordContent, opts.filenamePath) as string | undefined) : undefined,
      mimeType,
      size: typeof rawSize === 'number' ? rawSize : undefined,
      width: typeof rawWidth === 'number' ? rawWidth : undefined,
      height: typeof rawHeight === 'number' ? rawHeight : undefined,
      altText: opts.altTextPath ? (get(input.recordContent, opts.altTextPath) as string | undefined) : undefined,
      mediaType: this.inferMediaTypeFromMime(mimeType),
      urlExpiresAt: opts.urlExpires ? this.inferExpiryDate(input.recordContent) : undefined,
    };
  }

  /** Infer media type from a MIME type string. */
  private inferMediaTypeFromMime(mime: string | undefined): MediaType | undefined {
    if (!mime) return undefined;
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'document';
    return 'file';
  }

  /** Phase 1: Walk schema to find annotated asset fields. */
  private extractFromSchema(input: AssetExtractionInput, addEntry: (e: AssetIndexEntry) => void): void {
    const { fieldEntries } = this.getSchemaProperties(input.schema);
    if (!fieldEntries) return;

    for (const [fieldName, fieldSchema] of Object.entries(fieldEntries)) {
      if (!fieldSchema || typeof fieldSchema !== 'object') continue;
      const schema = fieldSchema as Record<string, unknown>;

      // Check for asset annotation on the field itself or in nested structures
      const assetOpts = this.findAssetFieldOptions(schema);
      if (!assetOpts) continue;

      const value = this.resolveFieldValue(input.recordContent, fieldName, input.schema);
      if (value == null) continue;

      if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
          const item = value[i] as Record<string, unknown>;
          if (!item || typeof item !== 'object') continue;
          const entry = this.buildEntryFromItem(input, item, assetOpts, `${fieldName}[${i}]`);
          if (entry) addEntry(entry);
        }
      } else if (typeof value === 'object') {
        const entry = this.buildEntryFromItem(input, value as Record<string, unknown>, assetOpts, fieldName);
        if (entry) addEntry(entry);
      }
    }
  }

  /** Phase 3: Extract from content blocks (Notion page_content, Wix richContent). */
  private extractFromContentBlocks(input: AssetExtractionInput, addEntry: (e: AssetIndexEntry) => void): void {
    const { service, recordContent } = input;

    if (service === Service.NOTION) {
      const pageContent = recordContent['page_content'] as unknown[] | undefined;
      if (Array.isArray(pageContent)) {
        for (let i = 0; i < pageContent.length; i++) {
          const block = pageContent[i] as Record<string, unknown> | undefined;
          if (!block || typeof block !== 'object') continue;
          this.extractFromNotionBlock(input, block, i, addEntry);
        }
      }
    }

    if (service === Service.WIX_BLOG) {
      const richContent = recordContent['richContent'] as Record<string, unknown> | undefined;
      const nodes = richContent?.['nodes'] as unknown[] | undefined;
      if (Array.isArray(nodes)) {
        for (let i = 0; i < nodes.length; i++) {
          const node = nodes[i] as Record<string, unknown> | undefined;
          if (!node || typeof node !== 'object') continue;
          this.extractFromWixNode(input, node, i, addEntry);
        }
      }
    }
  }

  private extractFromNotionBlock(
    input: AssetExtractionInput,
    block: Record<string, unknown>,
    index: number,
    addEntry: (e: AssetIndexEntry) => void,
  ): void {
    const type = block['type'] as string | undefined;
    if (!type) return;

    const mediaTypes: Record<string, MediaType> = {
      image: 'image',
      video: 'video',
      audio: 'audio',
      file: 'file',
      pdf: 'document',
    };

    const mediaType = mediaTypes[type];
    if (!mediaType) return;

    const blockData = block[type] as Record<string, unknown> | undefined;
    if (!blockData) return;

    const fileType = blockData['type'] as string | undefined;
    let url: string | undefined;
    let urlExpires = false;

    if (fileType === 'external') {
      const external = blockData['external'] as Record<string, unknown> | undefined;
      url = external?.['url'] as string | undefined;
    } else if (fileType === 'file') {
      const file = blockData['file'] as Record<string, unknown> | undefined;
      url = file?.['url'] as string | undefined;
      urlExpires = true;
    }

    if (!url) return;

    // Extract caption
    const caption = blockData['caption'] as Array<Record<string, unknown>> | undefined;
    const altText = caption?.map((c) => c['plain_text']).join('') || undefined;

    addEntry({
      workbookId: input.workbookId,
      service: input.service,
      remoteAssetId: urlExpires ? this.hashUrlPath(url) : this.hashUrl(url),
      dataFolderId: input.dataFolderId,
      url,
      altText,
      mediaType,
      urlExpiresAt: urlExpires ? this.parseNotionExpiry(blockData) : undefined,
    });
  }

  private extractFromWixNode(
    input: AssetExtractionInput,
    node: Record<string, unknown>,
    index: number,
    addEntry: (e: AssetIndexEntry) => void,
  ): void {
    const type = node['type'] as string | undefined;
    if (type !== 'IMAGE') return;

    const imageData = node['imageData'] as Record<string, unknown> | undefined;
    if (!imageData) return;

    const src = imageData['src'] as Record<string, unknown> | undefined;
    const url = (src?.['url'] as string) || (imageData['src'] as string | undefined);

    if (!url || typeof url !== 'string') return;

    const id = src?.['id'] as string | undefined;

    addEntry({
      workbookId: input.workbookId,
      service: input.service,
      remoteAssetId: id || this.hashUrl(url),
      dataFolderId: input.dataFolderId,
      url,
      altText: imageData['altText'] as string | undefined,
      width: typeof imageData['width'] === 'number' ? imageData['width'] : undefined,
      height: typeof imageData['height'] === 'number' ? imageData['height'] : undefined,
      mediaType: 'image',
    });
  }

  /**
   * Resolve a field value from record content, handling nested paths like "fields.X" or "fieldData.X".
   * For Notion, also unwraps the property wrapper (e.g. {id, type: "files", files: [...]}) to return the inner value.
   */
  private resolveFieldValue(
    content: Record<string, unknown>,
    fieldName: string,
    schema: Record<string, unknown>,
  ): unknown {
    // Direct property
    if (fieldName in content) return content[fieldName];

    // Check if schema wraps fields in "fields" (Airtable) or "fieldData" (Webflow) or "properties" (Notion)
    const schemaProps = schema['properties'] as Record<string, unknown> | undefined;
    if (!schemaProps) return undefined;

    for (const wrapperKey of ['fields', 'fieldData', 'properties']) {
      const wrapper = schemaProps[wrapperKey] as Record<string, unknown> | undefined;
      if (wrapper?.['properties']) {
        const wrapperProps = wrapper['properties'] as Record<string, unknown>;
        if (fieldName in wrapperProps) {
          const wrapperContent = content[wrapperKey] as Record<string, unknown> | undefined;
          const raw = wrapperContent?.[fieldName];
          // Notion properties are wrapped as {id, type, [type]: value} — unwrap to the inner value
          return this.unwrapNotionProperty(raw);
        }
      }
    }

    return undefined;
  }

  /**
   * Unwrap a Notion property wrapper object.
   * Notion stores property values as `{id: "...", type: "files", files: [...]}`.
   * This extracts the inner value (e.g. the files array) using the `type` key.
   */
  private unwrapNotionProperty(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const obj = value as Record<string, unknown>;
    const type = obj['type'];
    if (typeof type === 'string' && 'id' in obj && type in obj) {
      return obj[type];
    }
    return value;
  }

  /**
   * Get the schema properties, handling nested "fields", "fieldData", "properties" wrappers.
   * Returns a flat map of all field schemas that might contain assets, plus which fields are top-level.
   */
  private getSchemaProperties(schema: Record<string, unknown>): {
    fieldEntries: Record<string, unknown> | null;
    topLevelFields: Set<string>;
  } {
    const topProps = schema['properties'] as Record<string, unknown> | undefined;
    if (!topProps) return { fieldEntries: null, topLevelFields: new Set() };

    const result: Record<string, unknown> = {};
    const topLevelFields = new Set<string>();

    // Collect direct top-level properties
    for (const [key, value] of Object.entries(topProps)) {
      if (['fields', 'fieldData', 'properties'].includes(key)) {
        // Unwrap nested properties
        const nested = value as Record<string, unknown>;
        const nestedProps = nested['properties'] as Record<string, unknown> | undefined;
        if (nestedProps) {
          Object.assign(result, nestedProps);
        }
      } else {
        result[key] = value;
        topLevelFields.add(key);
      }
    }

    return { fieldEntries: result, topLevelFields };
  }

  private findAssetFieldOptions(schema: Record<string, unknown>): AssetFieldOptions | null {
    // Direct annotation
    if (schema[ASSET_FIELD]) return schema[ASSET_FIELD] as AssetFieldOptions;

    // Check inside items (for arrays)
    const items = schema['items'] as Record<string, unknown> | undefined;
    if (items?.[ASSET_FIELD]) return items[ASSET_FIELD] as AssetFieldOptions;

    // Check inside anyOf/oneOf (for unions)
    for (const key of ['anyOf', 'oneOf']) {
      const variants = schema[key] as Record<string, unknown>[] | undefined;
      if (variants) {
        for (const v of variants) {
          if (v[ASSET_FIELD]) return v[ASSET_FIELD] as AssetFieldOptions;
        }
      }
    }

    return null;
  }

  private buildEntryFromItem(
    input: AssetExtractionInput,
    item: Record<string, unknown>,
    opts: AssetFieldOptions,
    fieldPath: string,
  ): AssetIndexEntry | null {
    // Determine the URL
    const url = this.extractUrl(item, input.service);
    if (!url) return null;

    // Determine the stable ID
    let remoteAssetId: string;
    if (opts.idPath) {
      const id = item[opts.idPath];
      if (id && typeof id === 'string') {
        remoteAssetId = id;
      } else if (id != null) {
        // eslint-disable-next-line @typescript-eslint/no-base-to-string
        remoteAssetId = String(id);
      } else {
        remoteAssetId = this.hashUrl(url);
      }
    } else if (opts.urlExpires) {
      remoteAssetId = this.hashUrlPath(url);
    } else {
      remoteAssetId = this.hashUrl(url);
    }

    // For Notion files, don't use 'type' as mimeType since it's 'external'/'file'
    const notionFileTypes = new Set(['external', 'file']);
    const rawType = (item['type'] ?? item['mime_type'] ?? item['contentType']) as string | undefined;
    const mimeType = rawType && !notionFileTypes.has(rawType) ? rawType : undefined;

    return {
      workbookId: input.workbookId,
      service: input.service,
      remoteAssetId,
      dataFolderId: input.dataFolderId,
      url,
      filename: (item['filename'] ?? item['name']) as string | undefined,
      mimeType,
      size: typeof item['size'] === 'number' ? item['size'] : undefined,
      width: typeof item['width'] === 'number' ? item['width'] : undefined,
      height: typeof item['height'] === 'number' ? item['height'] : undefined,
      altText: (item['alt'] ?? item['altText'] ?? item['alt_text']) as string | undefined,
      mediaType: this.inferMediaType(item, fieldPath),
      urlExpiresAt: opts.urlExpires ? this.inferExpiryDate(item) : undefined,
    };
  }

  /** Extract URL from various connector-specific item shapes. */
  // TODO: We need to call into the connector here, not hardcode a bunch of connector heuristics
  private extractUrl(item: Record<string, unknown>, service: Service): string | undefined {
    // Direct url
    if (typeof item['url'] === 'string') return item['url'];

    // Notion: external.url or file.url
    if (service === Service.NOTION) {
      const external = item['external'] as Record<string, unknown> | undefined;
      if (typeof external?.['url'] === 'string') return external['url'];
      const file = item['file'] as Record<string, unknown> | undefined;
      if (typeof file?.['url'] === 'string') return file['url'];
    }

    // WordPress: source_url
    if (typeof item['source_url'] === 'string') return item['source_url'];

    return undefined;
  }

  private inferMediaType(item: Record<string, unknown>, fieldPath: string): MediaType | undefined {
    const mime = (item['type'] ?? item['mime_type'] ?? item['contentType'] ?? item['mimeType']) as string | undefined;
    // Skip Notion's 'external'/'file' type values — those aren't MIME types
    const notionFileTypes = new Set(['external', 'file']);
    if (mime && !notionFileTypes.has(mime)) {
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('video/')) return 'video';
      if (mime.startsWith('audio/')) return 'audio';
      if (mime === 'application/pdf') return 'document';
      return 'file';
    }

    // Infer from filename
    const filename = (item['filename'] ?? item['name']) as string | undefined;
    if (filename) {
      const ext = filename.split('.').pop()?.toLowerCase();
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext ?? '')) return 'image';
      if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext ?? '')) return 'video';
      if (['mp3', 'wav', 'ogg', 'flac', 'aac'].includes(ext ?? '')) return 'audio';
      if (ext === 'pdf') return 'document';
    }

    // Well-known property fields are typically images (cover, icon, heroImage)
    if (['cover', 'icon', 'heroImage'].includes(fieldPath)) {
      return 'image';
    }

    return undefined;
  }

  private inferExpiryDate(item: Record<string, unknown>): Date {
    // Notion: file.expiry_time
    const file = item['file'] as Record<string, unknown> | undefined;
    const expiryTime = file?.['expiry_time'] as string | undefined;
    if (expiryTime) {
      const d = new Date(expiryTime);
      if (!isNaN(d.getTime())) return d;
    }
    // Default: 2 hours from now (matches Airtable's expiry policy)
    return new Date(Date.now() + 2 * 60 * 60 * 1000);
  }

  private parseNotionExpiry(blockData: Record<string, unknown>): Date | undefined {
    const file = blockData['file'] as Record<string, unknown> | undefined;
    const expiryTime = file?.['expiry_time'] as string | undefined;
    if (expiryTime) {
      const d = new Date(expiryTime);
      if (!isNaN(d.getTime())) return d;
    }
    return undefined;
  }

  /** Hash the full URL for permanent URLs. */
  hashUrl(url: string): string {
    return createHash('sha256').update(url).digest('hex').slice(0, 32);
  }

  /** Hash only the URL path (before query params) for expiring URLs. */
  hashUrlPath(url: string): string {
    try {
      const parsed = new URL(url);
      return createHash('sha256').update(parsed.pathname).digest('hex').slice(0, 32);
    } catch {
      return this.hashUrl(url);
    }
  }
}
