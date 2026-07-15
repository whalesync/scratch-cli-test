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
 */
export function elideToMaxLength(text: string, maxLength: number, options?: { ellipsis?: string }): string {
  const ellipsis = options?.ellipsis ?? '…';
  const effectiveMaxLength = Math.max(0, Math.floor(maxLength));
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
