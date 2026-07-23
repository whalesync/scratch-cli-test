/**
 * Helpers for the Notion *write*-validation boundary: making an outbound property
 * payload satisfy Notion's per-span length rules, and — when the service rejects
 * a write anyway — naming the property that failed so the user-facing error
 * identifies the field rather than just echoing Notion's raw JSON path.
 */

/**
 * Notion caps a single rich-text (or title) span's `text.content` at 2000
 * characters. A property's `rich_text` / `title` array may hold many spans, and
 * Notion concatenates them with no separator on render — so a value longer than
 * the cap is split across consecutive spans rather than truncated.
 */
export const NOTION_RICH_TEXT_MAX_CONTENT_LENGTH = 2000;

/**
 * Split a string into consecutive chunks each no longer than
 * `maxContentLength` UTF-16 code units (Notion counts length the same way JS
 * `.length` does). The concatenation of the chunks is byte-for-byte the original
 * string — Notion renders the spans with no separator, so the split is invisible.
 *
 * The one subtlety is surrogate pairs (e.g. emoji): a naive slice at the cap
 * could cut a high/low surrogate in half. When the boundary lands on a high
 * surrogate we step back one code unit so the pair stays whole in one chunk.
 */
export function chunkStringToNotionRichTextLimit(
  content: string,
  maxContentLength: number = NOTION_RICH_TEXT_MAX_CONTENT_LENGTH,
): string[] {
  if (content.length <= maxContentLength) {
    return [content];
  }

  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    let end = Math.min(start + maxContentLength, content.length);
    // If the boundary would split a surrogate pair (the last code unit of the
    // chunk is a high surrogate), pull it into the next chunk instead. Guard
    // `end - 1 > start` so a chunk always makes forward progress.
    if (end < content.length && end - 1 > start) {
      const lastCodeUnit = content.charCodeAt(end - 1);
      const isHighSurrogate = lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff;
      if (isHighSurrogate) {
        end -= 1;
      }
    }
    chunks.push(content.slice(start, end));
    start = end;
  }
  return chunks;
}

type NotionTextSpan = {
  type?: unknown;
  text?: { content?: unknown } & Record<string, unknown>;
  plain_text?: unknown;
} & Record<string, unknown>;

/** A `text`-type span whose `text.content` exceeds Notion's per-span cap. */
function isOversizedTextSpan(span: unknown): span is NotionTextSpan & { text: { content: string } } {
  if (!span || typeof span !== 'object') {
    return false;
  }
  const candidate = span as NotionTextSpan;
  if (candidate.type !== 'text' || !candidate.text || typeof candidate.text.content !== 'string') {
    return false;
  }
  return candidate.text.content.length > NOTION_RICH_TEXT_MAX_CONTENT_LENGTH;
}

/**
 * Rewrite a `rich_text` / `title` property value's span array so no single
 * `text` span exceeds Notion's per-span length cap: each oversized span is
 * replaced by consecutive spans (same annotations / link / metadata) whose
 * contents chunk the original. Spans within the cap — and non-`text` spans
 * (mentions, equations) — pass through untouched.
 *
 * This adapts the outbound API payload to Notion's limit; it does not reshape
 * the record on disk. After the write, Notion returns the value as the split
 * spans, and the outbound unpack (`$.rich_text[*].plain_text`, concat) rejoins
 * them into the original string, so the round-trip is lossless.
 */
export function splitRichTextSpansToNotionLimit(spans: readonly unknown[]): unknown[] {
  // Fast path: nothing to split — return the original reference so callers that
  // compare identity (and existing snapshots) see no change.
  if (!spans.some(isOversizedTextSpan)) {
    return spans as unknown[];
  }

  const result: unknown[] = [];
  for (const span of spans) {
    if (!isOversizedTextSpan(span)) {
      result.push(span);
      continue;
    }

    const chunks = chunkStringToNotionRichTextLimit(span.text.content);
    const hasPlainText = typeof span.plain_text === 'string';
    for (const chunk of chunks) {
      result.push({
        ...span,
        text: { ...span.text, content: chunk },
        // `plain_text` mirrors `text.content` on a Notion read. Notion ignores it
        // on write, but a locally-created record is read back through this shape,
        // so keep each chunk's `plain_text` consistent with its content.
        ...(hasPlainText ? { plain_text: chunk } : {}),
      });
    }
  }
  return result;
}

/**
 * Best-effort extraction of the property name from a Notion validation-error
 * message. Notion phrases these against the request-body JSON path, e.g.
 *   "body.properties.Body.rich_text[0].text.content.length should be ≤ `2000`…"
 * from which we recover the field name ("Body") so the user-facing error can
 * name the field. Returns undefined when the message isn't property-scoped.
 */
export function extractNotionRejectedPropertyName(message: string): string | undefined {
  const match = /body\.properties\.([^.[\]]+)/.exec(message);
  const propertyName = match?.[1]?.trim();
  return propertyName ? propertyName : undefined;
}
