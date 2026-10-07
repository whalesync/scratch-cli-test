/**
 * Shorten `text` to at most `maxLength` characters by eliding from the MIDDLE, the
 * way macOS Finder shortens a long file name: keep the beginning, keep the end (the
 * last words — or digits! — are often what distinguishes one name from another), and,
 * when the text looks like a file name, keep its extension fully intact. The removed
 * middle is replaced with a single ellipsis (`…` by default).
 *
 * Middle elision beats a trailing "head…" cut because both ends of a generated
 * identifier carry meaning — `Customer Orders 2024 (North America)` and
 * `Customer Orders 2024 (Europe)` share a long prefix and differ only at the end, so
 * a head-only truncation would collapse them to the same string.
 *
 * `text` is returned unchanged when it already fits. For a `maxLength` too small to
 * hold the ellipsis plus any kept characters, the text is hard-cut from the front to
 * `maxLength` (a degenerate case that doesn't arise for real identifier limits).
 *
 * `lengthUnit: 'utf8Bytes'` measures `maxLength` in UTF-8 bytes instead of characters,
 * for a limit that counts encoded bytes (Postgres identifiers): the default `…` alone is
 * 3 bytes, so a character-measured result can overflow a byte limit. Bytes are kept in
 * whole characters — a multi-byte character or emoji is never split.
 */
export function elideToMaxLength(
  text: string,
  maxLength: number,
  options?: { ellipsis?: string; lengthUnit?: TextLengthUnit },
): string {
  const ellipsis = options?.ellipsis ?? '…';
  const effectiveMaxLength = Math.max(0, Math.floor(maxLength));
  if (options?.lengthUnit === 'utf8Bytes') return elideToMaxUtf8ByteLength(text, effectiveMaxLength, ellipsis);
  if (text.length <= effectiveMaxLength) return text;
  // Not even room for the ellipsis and one kept character on each side — hard-cut.
  if (effectiveMaxLength <= ellipsis.length) return text.slice(0, effectiveMaxLength);

  const keptCharacterBudget = effectiveMaxLength - ellipsis.length;
  const extension = fileExtensionOf(text);

  // Split the budget between a leading head and a trailing tail, favouring the head
  // by one character on odd budgets. Grow the tail if needed so the whole extension
  // survives inside it (the ellipsis must never land in the middle of `.pdf`).
  let headLength = Math.ceil(keptCharacterBudget / 2);
  let tailLength = keptCharacterBudget - headLength;
  if (extension.length > tailLength) {
    tailLength = Math.min(keptCharacterBudget, extension.length);
    headLength = keptCharacterBudget - tailLength;
  }

  const head = text.slice(0, headLength);
  // The tail is taken from the raw end of the text, so it already includes the
  // extension — we only had to size it above so the ellipsis clears the extension.
  const tail = tailLength > 0 ? text.slice(text.length - tailLength) : '';
  return `${head}${ellipsis}${tail}`;
}

/** The unit a text length limit is measured in: UTF-16 characters (`string.length`) or UTF-8 bytes. */
export type TextLengthUnit = 'characters' | 'utf8Bytes';

/** `text`'s length in `lengthUnit` — `string.length` for characters, its UTF-8 encoded size for bytes. */
export function measureTextLength(text: string, lengthUnit: TextLengthUnit): number {
  return lengthUnit === 'utf8Bytes' ? Buffer.byteLength(text, 'utf8') : text.length;
}

/**
 * {@link elideToMaxLength} with `maxUtf8ByteLength` counted in UTF-8 bytes: the same head-favouring
 * middle elision and extension rule, but the head and tail are built from whole code points whose
 * encoded size fits the byte budget left after the ellipsis.
 */
function elideToMaxUtf8ByteLength(text: string, maxUtf8ByteLength: number, ellipsis: string): string {
  if (measureTextLength(text, 'utf8Bytes') <= maxUtf8ByteLength) return text;
  const codePoints = Array.from(text);
  const ellipsisByteLength = measureTextLength(ellipsis, 'utf8Bytes');
  // Not even room for the ellipsis and one kept character on each side — hard-cut.
  if (maxUtf8ByteLength <= ellipsisByteLength) {
    return leadingCodePointsWithinUtf8ByteBudget(codePoints, maxUtf8ByteLength).join('');
  }

  const keptByteBudget = maxUtf8ByteLength - ellipsisByteLength;
  // An extension is ASCII-only (see fileExtensionOf), so its character count is its byte count.
  const extensionByteLength = fileExtensionOf(text).length;
  let headByteBudget = Math.ceil(keptByteBudget / 2);
  if (extensionByteLength > keptByteBudget - headByteBudget) {
    headByteBudget = keptByteBudget - Math.min(keptByteBudget, extensionByteLength);
  }

  const headCodePoints = leadingCodePointsWithinUtf8ByteBudget(codePoints, headByteBudget);
  // Bytes the head couldn't use (its next character didn't fit whole) go to the tail.
  const tailByteBudget = keptByteBudget - measureTextLength(headCodePoints.join(''), 'utf8Bytes');
  const tailCodePoints = leadingCodePointsWithinUtf8ByteBudget([...codePoints].reverse(), tailByteBudget).reverse();
  return `${headCodePoints.join('')}${ellipsis}${tailCodePoints.join('')}`;
}

/** The longest leading run of `codePoints` whose UTF-8 encoding fits within `utf8ByteBudget`. */
function leadingCodePointsWithinUtf8ByteBudget(codePoints: string[], utf8ByteBudget: number): string[] {
  const keptCodePoints: string[] = [];
  let usedUtf8Bytes = 0;
  for (const codePoint of codePoints) {
    const codePointUtf8ByteLength = measureTextLength(codePoint, 'utf8Bytes');
    if (usedUtf8Bytes + codePointUtf8ByteLength > utf8ByteBudget) break;
    keptCodePoints.push(codePoint);
    usedUtf8Bytes += codePointUtf8ByteLength;
  }
  return keptCodePoints;
}

/**
 * The file-extension suffix of `text` (including the leading dot), or `''` when it
 * has none that reads like a real extension. Only a short, alphanumeric suffix after
 * a non-leading dot qualifies, so a sentence's period or a dotted identifier
 * (`created_by.id`, `www.example`) is not mistaken for an extension.
 */
function fileExtensionOf(text: string): string {
  const lastDotIndex = text.lastIndexOf('.');
  if (lastDotIndex <= 0 || lastDotIndex === text.length - 1) return '';
  const extensionWithDot = text.slice(lastDotIndex);
  if (extensionWithDot.length > 9) return '';
  return /^\.[A-Za-z0-9]+$/.test(extensionWithDot) ? extensionWithDot : '';
}

/**
 * The outcome of {@link safeJsonParse}: either the parsed value, or the error that
 * `JSON.parse` threw. A discriminated union (not `T | null`) is used deliberately —
 * `JSON.parse('null')` is a *successful* parse yielding `null`, which a nullable
 * return could not tell apart from a failure.
 */
export type SafeJsonParseResult<T> = { ok: true; value: T } | { ok: false; error: Error };

/**
 * Parse `text` as JSON without letting a `SyntaxError` escape to the caller.
 *
 * Reach for this whenever the JSON comes from an untrusted or fallible source —
 * a file read from disk or git (which may be truncated by an interrupted pull,
 * DEV-9981), a network/connector response, a store like Redis, or unvalidated
 * request input. Returning a result lets each caller decide whether a malformed
 * payload should be skipped, defaulted, or surfaced as a clear error, rather than
 * crashing with an opaque `Unexpected end of JSON input`.
 */
export function safeJsonParse<T = unknown>(text: string): SafeJsonParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

/**
 * Return the enum value in string enum `T` named `strVal`, or `defaultValue` if it isn't recognized.
 * Accepts values of `strVal` that are either case name ('FOO') OR case value ('foo').
 */
export function stringToEnum<T extends object, DefaultType>(
  strVal: string,
  type: T,
  defaultValue: DefaultType,
): T[keyof T] | DefaultType {
  for (const [k, v] of Object.entries(type)) {
    if (strVal === k || strVal === v) {
      return type[k as keyof T];
    }
  }
  return defaultValue;
}
