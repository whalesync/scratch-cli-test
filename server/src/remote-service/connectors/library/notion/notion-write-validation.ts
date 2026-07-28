/**
 * Helpers for the Notion *write*-validation boundary: making an outbound property
 * payload satisfy Notion's per-span length rules, and — when the service rejects
 * a write anyway — naming the property that failed so the user-facing error
 * identifies the field rather than just echoing Notion's raw JSON path.
 */

import { isValidWritableCalendarDateString } from 'src/utils/date-validity';

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
 * Notion date properties accept only a calendar year Notion can represent: an
 * RFC 3339 timestamp (or bare `YYYY-MM-DD`) with a four-digit year, 0001–9999.
 * A value outside that range is *accepted* by Notion's write API but stored as
 * its invalid sentinel — the property literally becomes `{ start: "Invalid
 * DateTime" }`, which shows as garbage in the UI and breaks Notion-side
 * filters/sorts (DEV-10960).
 *
 * The canonical trigger is an extended-year ISO string such as
 * `"+010000-01-01T07:59:59.000Z"` — produced when a Postgres `timestamp` of
 * `9999-12-31 23:59:59` rolls into year 10000 as it crosses a UTC offset, then
 * `Date#toISOString()` emits the six-digit `±YYYYYY` extended-year form. Notion
 * can't parse that, so the write path must skip the property (leaving the field
 * unchanged) rather than ship a value Notion mangles.
 */
export const NOTION_MIN_DATE_YEAR = 1;
export const NOTION_MAX_DATE_YEAR = 9999;

/**
 * Whether a single Notion date boundary string (`date.start` / `date.end`) is
 * one Notion can store faithfully: it must name a real calendar instant AND fall
 * within Notion's four-digit-year range. Rejects
 *   - nonexistent calendar dates such as `"2026-02-29"` (2026 is not a leap year),
 *     which `new Date(...)` silently rolls over to March 1 rather than flagging, so
 *     Notion's API rejects the value verbatim and the whole record is lost (DEV-11044);
 *   - unparseable values; and
 *   - the extended-year form (`+010000-…`, whose `getUTCFullYear()` is 10000),
 *     which Notion accepts but stores as its `"Invalid DateTime"` sentinel (DEV-10960).
 * The calendar-validity check is the shared one used by the [core] sync boundary; the
 * year-range check on top of it is Notion-specific.
 */
export function isNotionWritableDateBoundary(value: string): boolean {
  if (!isValidWritableCalendarDateString(value)) {
    return false;
  }
  const year = new Date(value).getUTCFullYear();
  return year >= NOTION_MIN_DATE_YEAR && year <= NOTION_MAX_DATE_YEAR;
}

/**
 * Inspect an outbound Notion `date` property value (`{ start, end?, time_zone? }`
 * or `null`) and return the first boundary string Notion can't store faithfully,
 * or `undefined` when every present boundary is writable (including a `null`
 * clear, which carries no boundary). Callers use the returned value to skip the
 * property with a per-field warning.
 */
export function findUnwritableNotionDateBoundary(dateValue: unknown): string | undefined {
  if (!dateValue || typeof dateValue !== 'object') {
    return undefined;
  }
  const { start, end } = dateValue as { start?: unknown; end?: unknown };
  return [start, end].find(
    (boundary): boundary is string => typeof boundary === 'string' && !isNotionWritableDateBoundary(boundary),
  );
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
