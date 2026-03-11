import { createHash } from 'crypto';
import { get } from 'lodash';
import { ConnectorAssetExtractionInput, ConnectorAssetResult, MediaType } from 'src/asset/asset.types';
import { ASSET_FIELD, ASSET_TABLE, AssetFieldOptions, AssetTableOptions } from './json-schema';

/**
 * Shared helpers for connector asset extraction.
 * Connectors call these from their `extractAssets` implementation.
 */

/** Hash the full URL for permanent URLs. */
export function hashUrl(url: string): string {
  return createHash('sha256').update(url).digest('hex').slice(0, 32);
}

/** Hash only the URL path (before query params) for expiring URLs. */
export function hashUrlPath(url: string): string {
  try {
    const parsed = new URL(url);
    return createHash('sha256').update(parsed.pathname).digest('hex').slice(0, 32);
  } catch {
    return hashUrl(url);
  }
}

/** Strip query params from a URL, returning origin + pathname. Falls back to the original string on parse failure. */
export function stripQueryParams(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

/** Infer media type from a MIME type string. */
export function inferMediaTypeFromMime(mime: string | undefined): MediaType | undefined {
  if (!mime) return undefined;
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'document';
  return 'file';
}

/** Infer media type from MIME, filename, or field path. */
export function inferMediaType(
  item: Record<string, unknown>,
  fieldPath: string,
  mimeExclusions?: Set<string>,
): MediaType | undefined {
  const mime = (item['type'] ?? item['mime_type'] ?? item['contentType'] ?? item['mimeType']) as string | undefined;
  if (mime && !mimeExclusions?.has(mime)) {
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/')) return 'video';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime === 'application/pdf') return 'document';
    return 'file';
  }

  const filename = (item['filename'] ?? item['name']) as string | undefined;
  if (filename) {
    const ext = filename.split('.').pop()?.toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'].includes(ext ?? '')) return 'image';
    if (['mp4', 'mov', 'avi', 'webm', 'mkv'].includes(ext ?? '')) return 'video';
    if (['mp3', 'wav', 'ogg', 'flac', 'aac'].includes(ext ?? '')) return 'audio';
    if (ext === 'pdf') return 'document';
  }

  if (['cover', 'icon', 'heroImage'].includes(fieldPath)) {
    return 'image';
  }

  return undefined;
}

/**
 * Extract assets from a standalone entity table (Phase 0).
 * Used when the schema has `x-scratch-asset-table` — the entire record IS an asset.
 */
export function extractStandaloneEntity(input: ConnectorAssetExtractionInput): ConnectorAssetResult | null {
  const opts = input.schema[ASSET_TABLE] as AssetTableOptions | undefined;
  if (!opts) return null;

  const url = get(input.recordContent, opts.urlPath) as string | undefined;
  if (!url || typeof url !== 'string') return null;

  const remoteAssetId = input.recordRemoteId ?? hashUrl(url);
  const mimeType = opts.mimeTypePath ? (get(input.recordContent, opts.mimeTypePath) as string | undefined) : undefined;

  const rawSize = opts.sizePath ? get(input.recordContent, opts.sizePath) : undefined;
  const rawWidth = opts.widthPath ? get(input.recordContent, opts.widthPath) : undefined;
  const rawHeight = opts.heightPath ? get(input.recordContent, opts.heightPath) : undefined;

  return {
    remoteAssetId,
    url,
    filename: opts.filenamePath ? (get(input.recordContent, opts.filenamePath) as string | undefined) : undefined,
    mimeType,
    size: typeof rawSize === 'number' ? rawSize : undefined,
    width: typeof rawWidth === 'number' ? rawWidth : undefined,
    height: typeof rawHeight === 'number' ? rawHeight : undefined,
    altText: opts.altTextPath ? (get(input.recordContent, opts.altTextPath) as string | undefined) : undefined,
    mediaType: inferMediaTypeFromMime(mimeType),
    urlExpiresAt: opts.urlExpires ? defaultExpiryDate() : undefined,
  };
}

/**
 * Schema-driven asset extraction (Phase 1).
 * Walks schema properties for `x-scratch-asset-field` annotations and extracts matching assets.
 *
 * Connectors must provide `extractUrl` to handle their service-specific URL shapes,
 * and `resolveFieldValue` to handle their service-specific field wrapping.
 */
export function extractFromAnnotatedSchema(
  input: ConnectorAssetExtractionInput,
  options: {
    extractUrl: (item: Record<string, unknown>) => string | undefined;
    resolveFieldValue: (
      content: Record<string, unknown>,
      fieldName: string,
      schema: Record<string, unknown>,
    ) => unknown;
    extractMimeType?: (item: Record<string, unknown>) => string | undefined;
    inferMediaType?: (item: Record<string, unknown>, fieldPath: string) => MediaType | undefined;
    inferExpiryDate?: (item: Record<string, unknown>) => Date;
    /** Override the default remoteAssetId. */
    generateAssetId?: (url: string) => string;
  },
): ConnectorAssetResult[] {
  const results: ConnectorAssetResult[] = [];
  const { fieldEntries } = getSchemaProperties(input.schema);
  if (!fieldEntries) return results;

  for (const [fieldName, fieldSchema] of Object.entries(fieldEntries)) {
    if (!fieldSchema || typeof fieldSchema !== 'object') continue;
    const schema = fieldSchema as Record<string, unknown>;

    const assetOpts = findAssetFieldOptions(schema);
    if (!assetOpts) continue;

    const value = options.resolveFieldValue(input.recordContent, fieldName, input.schema);
    if (value == null) continue;

    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const item = value[i] as Record<string, unknown>;
        if (!item || typeof item !== 'object') continue;
        const entry = buildEntryFromItem(item, assetOpts, `${fieldName}[${i}]`, options);
        if (entry) results.push(entry);
      }
    } else if (typeof value === 'object') {
      const entry = buildEntryFromItem(value as Record<string, unknown>, assetOpts, fieldName, options);
      if (entry) results.push(entry);
    }
  }

  return results;
}

/** Default expiry: 2 hours from now (matches Airtable's expiry policy). */
export function defaultExpiryDate(): Date {
  return new Date(Date.now() + 2 * 60 * 60 * 1000);
}

// ── Internal helpers ──

function buildEntryFromItem(
  item: Record<string, unknown>,
  opts: AssetFieldOptions,
  fieldPath: string,
  options: {
    extractUrl: (item: Record<string, unknown>) => string | undefined;
    extractMimeType?: (item: Record<string, unknown>) => string | undefined;
    inferMediaType?: (item: Record<string, unknown>, fieldPath: string) => MediaType | undefined;
    inferExpiryDate?: (item: Record<string, unknown>) => Date;
    generateAssetId?: (url: string) => string;
  },
): ConnectorAssetResult | null {
  const url = options.extractUrl(item);
  if (!url) return null;

  let remoteAssetId: string;
  if (opts.idPath) {
    const id = item[opts.idPath];
    if (id && typeof id === 'string') {
      remoteAssetId = id;
    } else if (id != null) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      remoteAssetId = String(id);
    } else {
      remoteAssetId = hashUrl(url);
    }
  } else if (options.generateAssetId) {
    remoteAssetId = options.generateAssetId(url);
  } else {
    // Fallback when the connector doesn't provide any way to identify the asset
    // TODO: If we want to support this, we'll need a transformer that replicates the URL hashing to sync assets
    remoteAssetId = hashUrl(url);
  }

  const mimeType = options.extractMimeType ? options.extractMimeType(item) : defaultExtractMimeType(item);
  const mediaType = options.inferMediaType ? options.inferMediaType(item, fieldPath) : inferMediaType(item, fieldPath);

  return {
    remoteAssetId,
    url,
    filename: (item['filename'] ?? item['name']) as string | undefined,
    mimeType,
    size: typeof item['size'] === 'number' ? item['size'] : undefined,
    width: typeof item['width'] === 'number' ? item['width'] : undefined,
    height: typeof item['height'] === 'number' ? item['height'] : undefined,
    altText: (item['alt'] ?? item['altText'] ?? item['alt_text']) as string | undefined,
    mediaType,
    urlExpiresAt: opts.urlExpires ? (options.inferExpiryDate?.(item) ?? defaultExpiryDate()) : undefined,
  };
}

function defaultExtractMimeType(item: Record<string, unknown>): string | undefined {
  const raw = (item['type'] ?? item['mime_type'] ?? item['contentType']) as string | undefined;
  return raw ?? undefined;
}

/** Get schema properties, unwrapping nested 'fields'/'fieldData'/'properties' wrappers. */
function getSchemaProperties(schema: Record<string, unknown>): {
  fieldEntries: Record<string, unknown> | null;
  topLevelFields: Set<string>;
} {
  const topProps = schema['properties'] as Record<string, unknown> | undefined;
  if (!topProps) return { fieldEntries: null, topLevelFields: new Set() };

  const result: Record<string, unknown> = {};
  const topLevelFields = new Set<string>();

  for (const [key, value] of Object.entries(topProps)) {
    if (['fields', 'fieldData', 'properties'].includes(key)) {
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

function findAssetFieldOptions(schema: Record<string, unknown>): AssetFieldOptions | null {
  if (schema[ASSET_FIELD]) return schema[ASSET_FIELD] as AssetFieldOptions;

  const items = schema['items'] as Record<string, unknown> | undefined;
  if (items?.[ASSET_FIELD]) return items[ASSET_FIELD] as AssetFieldOptions;

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

/**
 * Default field value resolver — handles nested 'fields'/'fieldData'/'properties' wrappers.
 * Use this as the base; connectors can wrap it with additional logic (e.g. Notion property unwrapping).
 */
export function defaultResolveFieldValue(
  content: Record<string, unknown>,
  fieldName: string,
  schema: Record<string, unknown>,
): unknown {
  if (fieldName in content) return content[fieldName];

  const schemaProps = schema['properties'] as Record<string, unknown> | undefined;
  if (!schemaProps) return undefined;

  for (const wrapperKey of ['fields', 'fieldData', 'properties']) {
    const wrapper = schemaProps[wrapperKey] as Record<string, unknown> | undefined;
    if (wrapper?.['properties']) {
      const wrapperProps = wrapper['properties'] as Record<string, unknown>;
      if (fieldName in wrapperProps) {
        const wrapperContent = content[wrapperKey] as Record<string, unknown> | undefined;
        return wrapperContent?.[fieldName];
      }
    }
  }

  return undefined;
}
