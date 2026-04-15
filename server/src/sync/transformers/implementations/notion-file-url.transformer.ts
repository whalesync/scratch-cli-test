import { Type } from '@sinclair/typebox';
import { NotionFileUrlOptions, TransformerTypes } from '@spinner/shared-types';
import { registerTransformer } from '../transformer-registry';
import { FieldTransformer, TransformContext, TransformResult } from '../transformer.types';

/**
 * Extracts file URLs from a Notion file property and strips query parameters.
 *
 * The input is typically the full Notion property object:
 * ```
 * { id: "gh%3FQ", type: "files", files: [
 *   { name: "img.jpg", type: "external", external: { url: "..." } },
 *   { name: "doc.pdf", type: "file", file: { url: "...?X-Amz-Signature=...", expiry_time: "..." } },
 * ]}
 * ```
 *
 * The transformer unwraps the `files` array, extracts URLs from each item
 * (matching the connector's extractUrl logic), and strips query strings
 * to produce stable identifiers suitable for asset matching.
 *
 * Also handles the case where the input is already the files array directly.
 *
 * Options:
 * - arrayHandling: 'array' (default) returns all URLs as an array, 'first' returns only the first
 */
export const notionFileUrlTransformer: FieldTransformer = {
  type: TransformerTypes.NotionFileUrl,

  optionsSchema: [
    {
      key: 'arrayHandling',
      widget: 'select',
      label: 'Multiple results',
      description: 'How to handle multiple file URLs',
      defaultValue: 'array',
      selectOptions: [
        { value: 'array', label: 'Array (default)' },
        { value: 'first', label: 'First value' },
      ],
    },
  ],

  paramType: () => Type.Any(),
  returnType: () => Type.Any(),

  // eslint-disable-next-line @typescript-eslint/require-await
  async transform(ctx: TransformContext): Promise<TransformResult> {
    const { sourceValue, options } = ctx;
    const { arrayHandling = 'array' } = (options ?? {}) as NotionFileUrlOptions;

    if (sourceValue === null || sourceValue === undefined) {
      return { success: true, value: null };
    }

    // Unwrap: if the input is the Notion property wrapper, dig into the `files` array.
    // Otherwise treat the input itself as the array of file items.
    const items = resolveFileItems(sourceValue);
    const urls: string[] = [];

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const url = extractNotionFileUrl(record);
      if (url) urls.push(stripQueryParams(url));
    }

    if (urls.length === 0) {
      return { success: true, value: null };
    }

    if (arrayHandling === 'first') {
      return { success: true, value: urls[0] };
    }

    return { success: true, value: urls };
  },
};

/**
 * Resolve the array of file items from the source value.
 * Handles both the Notion property wrapper `{ type: "files", files: [...] }` and a bare array.
 */
function resolveFileItems(sourceValue: unknown): unknown[] {
  if (Array.isArray(sourceValue)) return sourceValue;

  if (typeof sourceValue === 'object' && sourceValue !== null) {
    const obj = sourceValue as Record<string, unknown>;
    const files = obj['files'];
    if (Array.isArray(files)) return files;
    // Single object without a files wrapper — treat as a single item
    return [sourceValue];
  }

  return [];
}

/** Extract the URL from a single Notion file item, matching the connector's extractUrl logic. */
function extractNotionFileUrl(item: Record<string, unknown>): string | undefined {
  // External file: { type: 'external', external: { url: '...' } }
  const external = item['external'] as Record<string, unknown> | undefined;
  if (typeof external?.['url'] === 'string') return external['url'];

  // Hosted file: { type: 'file', file: { url: '...' } }
  const file = item['file'] as Record<string, unknown> | undefined;
  if (typeof file?.['url'] === 'string') return file['url'];

  // Direct url property
  if (typeof item['url'] === 'string') return item['url'];

  return undefined;
}

function stripQueryParams(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url;
  }
}

// Auto-register on import
registerTransformer(notionFileUrlTransformer);
