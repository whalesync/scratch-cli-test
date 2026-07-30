/**
 * Wix's internal media URI, and how to turn it into something usable.
 *
 * The `@wix/blog` SDK hands back a post's cover image as
 * `wix:image://v1/<mediaId>/<filename>#originWidth=W&originHeight=H` (the REST API returns an object
 * with a real URL instead — we store the SDK shape, so we get the URI). Nothing downstream can render
 * that: not a browser, not an Airtable attachment, not a Notion file property. Every Wix-hosted image
 * is also served from `https://static.wixstatic.com/media/<mediaId>`, so capturing the media id is
 * enough to recover a public URL.
 *
 * `[^/#]+` stops at either the filename separator or the fragment, which covers both forms Wix emits
 * (`wix:image://v1/<id>/name.jpg#…` and `wix:image://v1/<id>#…`).
 *
 * The pattern lives here as a string so the default view can hand it to the declarative
 * `replace_regex` transformer AND `extractAssets` can compile the identical rule — one definition, so
 * the grid, the export and the asset extractor can never disagree about what a cover image resolves to.
 */
export const WIX_MEDIA_URI_PATTERN = '^wix:image://v1/([^/#]+).*$';
export const WIX_MEDIA_URI_REPLACEMENT = 'https://static.wixstatic.com/media/$1';

/**
 * Resolve a Wix media URI to a public https URL. Returns `undefined` for anything that isn't a Wix
 * media URI — including a value that is already an https URL, which callers should use as-is.
 */
export function resolveWixMediaUriToUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const match = new RegExp(WIX_MEDIA_URI_PATTERN).exec(value);
  if (!match) return undefined;
  return `https://static.wixstatic.com/media/${match[1]}`;
}

/** The Wix media id inside a `wix:image://` URI, used as the asset's stable remote id. */
export function wixMediaIdFromUri(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return new RegExp(WIX_MEDIA_URI_PATTERN).exec(value)?.[1];
}
