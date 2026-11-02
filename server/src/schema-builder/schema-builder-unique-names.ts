import type { NameCharacterRules, NameLengthUnit, NameStyle } from '@spinner/shared-types';
import { assertUnreachable } from 'src/utils/asserts';
import { elideToMaxLength, measureTextLength } from 'src/utils/helpers';

/**
 * Unique-name allocation for create-schema plan generation (DEV-10441).
 *
 * The plan generator names fields and tables from their source's display
 * label, so two source fields (or two source tables, or a new table and one
 * that already exists on the destination) can resolve to the same name. The
 * downstream zod schema (`create-schema.dto.ts`) then rejects the plan with
 * `DUPLICATE_FIELD_NAME` / `DUPLICATE_TABLE_NAME`, so the generated plan is
 * un-creatable. These helpers deduplicate names up front by appending a numeric
 * suffix, using the SAME case-insensitive identity the zod duplicate check uses
 * so a deduplicated plan is guaranteed to pass validation.
 *
 * When the destination connector caps identifier length (`maxLength`), names are
 * additionally elided to fit — reserving room for the numeric suffix — so the plan
 * never trips the connector's `FIELD_NAME_TOO_LONG` / `TABLE_NAME_TOO_LONG` check
 * (DEV-10816). `maxLength` is measured in the connector's `NameLengthUnit` — UTF-8
 * bytes for Postgres, whose 63-byte limit a character-measured `…` would overflow.
 *
 * When the destination can't hold some characters in a name (`NameCharacterRules`,
 * e.g. MySQL's emoji and trailing spaces), {@link fitNameToCharacterRules} removes
 * them FIRST, so elision and dedup work on a name the destination can use (DEV-12413).
 *
 * When the destination styles its names (`NameStyle`, e.g. Postgres's lowercase SQL
 * identifiers), {@link convertNameToNameStyle} converts the name before anything else,
 * and elision and dedup join their pieces in that style (`_` rather than `…` and ` 2`),
 * so the final name keeps the style.
 */

/**
 * Case-insensitive identity used everywhere a create-schema name is compared.
 * Matches the zod duplicate rule (`value.trim().toLowerCase()`) so the
 * allocator and the validator agree on what counts as a collision.
 */
export function normalizeNameForUniqueness(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Return `requestedName` (elided to `maxLength` when given — see
 * {@link elideNameToMaxLength}) unchanged when its normalized form is not already
 * in `takenNormalizedNames`; otherwise return the first free `"requestedName 2"`,
 * `"requestedName 3"`, … (`requestedName_2`, … for a `'lowercaseSqlIdentifier'`
 * name). The normalized form of the chosen name is added to the set so the next call
 * sees it. Cascading-collision safe: a candidate suffix that is itself already taken
 * is skipped.
 *
 * When `maxLength` is given, every returned name is guaranteed to fit within it
 * (measured in `lengthUnit`, characters by default): the bare name is elided to
 * `maxLength`, and a suffixed candidate elides the base to leave room for its ` N`
 * suffix, so `base + " N"` still fits.
 *
 * The caller compares the returned name to `elideNameToMaxLength(requestedName,
 * maxLength, lengthUnit, nameStyle)` to detect a dedup rename, and to `requestedName`
 * to detect elision. The first duplicate gets suffix `2` (the original keeps its bare,
 * elided name).
 */
export function allocateUniqueName(
  requestedName: string,
  takenNormalizedNames: Set<string>,
  maxLength?: number,
  lengthUnit: NameLengthUnit = 'characters',
  nameStyle: NameStyle = 'asGiven',
): string {
  const elidedName = elideNameToMaxLength(requestedName, maxLength, lengthUnit, nameStyle);
  if (!takenNormalizedNames.has(normalizeNameForUniqueness(elidedName))) {
    takenNormalizedNames.add(normalizeNameForUniqueness(elidedName));
    return elidedName;
  }
  let suffix = 2;
  let candidate = buildSuffixedCandidate(requestedName, suffix, maxLength, lengthUnit, nameStyle);
  while (takenNormalizedNames.has(normalizeNameForUniqueness(candidate))) {
    suffix += 1;
    candidate = buildSuffixedCandidate(requestedName, suffix, maxLength, lengthUnit, nameStyle);
  }
  takenNormalizedNames.add(normalizeNameForUniqueness(candidate));
  return candidate;
}

/**
 * `requestedName` middle-elided to `maxLength` (in `lengthUnit`), or unchanged when no limit is given (or it
 * already fits). A `'lowercaseSqlIdentifier'` name is joined with `_` instead of `…`, with any doubled or
 * trailing `_` the cut leaves removed, so the shortened name still needs no quoting.
 */
export function elideNameToMaxLength(
  requestedName: string,
  maxLength?: number,
  lengthUnit: NameLengthUnit = 'characters',
  nameStyle: NameStyle = 'asGiven',
): string {
  if (maxLength === undefined) return requestedName;
  const nameStyleJoiners = nameStyleJoinersFor(nameStyle);
  const elidedName = elideToMaxLength(requestedName, maxLength, {
    lengthUnit,
    ellipsis: nameStyleJoiners.elisionMarker,
  });
  if (elidedName === requestedName) return elidedName;
  return nameStyle === 'lowercaseSqlIdentifier' ? elidedName.replace(/_{2,}/g, '_').replace(/_+$/, '') : elidedName;
}

/**
 * `"<base> <suffix>"` (`<base>_<suffix>` for a `'lowercaseSqlIdentifier'` name) where the base is elided so the
 * whole candidate fits within `maxLength` (the suffix is reserved first, measured in `lengthUnit`). With no
 * limit the base is used verbatim. This is the name {@link allocateUniqueName} hands out for `suffix`, so a
 * re-plan can find a column that was deduplicated at create.
 */
export function buildSuffixedCandidate(
  requestedName: string,
  suffix: number,
  maxLength: number | undefined,
  lengthUnit: NameLengthUnit,
  nameStyle: NameStyle,
): string {
  const suffixString = `${nameStyleJoinersFor(nameStyle).dedupSuffixSeparator}${suffix}`;
  if (maxLength === undefined) return `${requestedName}${suffixString}`;
  const base = elideNameToMaxLength(
    requestedName,
    Math.max(0, maxLength - measureTextLength(suffixString, lengthUnit)),
    lengthUnit,
    nameStyle,
  );
  return `${base}${suffixString}`;
}

/** What joins the pieces of a shortened or deduplicated name in `nameStyle`, so the result keeps that style. */
function nameStyleJoinersFor(nameStyle: NameStyle): { elisionMarker: string; dedupSuffixSeparator: string } {
  switch (nameStyle) {
    case 'asGiven':
      return { elisionMarker: '…', dedupSuffixSeparator: ' ' };
    case 'lowercaseSqlIdentifier':
      return { elisionMarker: '_', dedupSuffixSeparator: '_' };
    default:
      return assertUnreachable(nameStyle);
  }
}

/**
 * Prefix for a `'lowercaseSqlIdentifier'` table or field name that would otherwise start with a digit — an
 * unquoted SQL identifier can't (`2fa_enabled` is a syntax error; `_2fa_enabled` is fine).
 */
const LOWERCASE_SQL_IDENTIFIER_LEADING_DIGIT_PREFIX = '_';

/**
 * `name` converted to `nameStyle`, before any other name rule applies (see {@link NameStyle}). A
 * `'lowercaseSqlIdentifier'` name with a letter or digit the conversion can't keep ("名前", "Имя (полное)")
 * keeps its original name, since converting it would leave nothing of it, or a meaningless fragment. One that
 * converts to nothing because it is all punctuation or emoji becomes `fallbackName`, converted the same way.
 * `'asGiven'` returns `name` unchanged.
 */
export function convertNameToNameStyle(name: string, nameStyle: NameStyle, fallbackName: string): string {
  switch (nameStyle) {
    case 'asGiven':
      return name;
    case 'lowercaseSqlIdentifier':
      if (hasLetterOrDigitTheLowercaseSqlIdentifierFoldDrops(name)) return name;
      return (
        foldNameToLowercaseSqlIdentifier(name, LOWERCASE_SQL_IDENTIFIER_LEADING_DIGIT_PREFIX) ||
        foldNameToLowercaseSqlIdentifier(fallbackName, LOWERCASE_SQL_IDENTIFIER_LEADING_DIGIT_PREFIX)
      );
    default:
      return assertUnreachable(nameStyle);
  }
}

/**
 * Whether `name` has a letter or digit that {@link foldNameToLowercaseSqlIdentifier} drops: one from a script
 * other than Latin ("名前", "Имя"), or a Latin letter with no unaccented form ("ß"). An accented Latin letter
 * folds to its base letter ("é" → `e`), and emoji and punctuation aren't letters, so neither counts.
 */
function hasLetterOrDigitTheLowercaseSqlIdentifierFoldDrops(name: string): boolean {
  const nameWithoutAccentsOrFoldableCharacters = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[a-zA-Z0-9]/g, '');
  return /[\p{L}\p{N}]/u.test(nameWithoutAccentsOrFoldableCharacters);
}

/**
 * Fold a human-chosen name into an identifier hand-written SQL can use without quotes: lower case, accents
 * dropped ("Café" → `cafe`), every run of characters outside `a-z0-9` turned into one `_`, no leading or
 * trailing `_`, and `leadingDigitPrefix` in front of a leading digit. Returns `''` when nothing usable is
 * left, so the caller picks its own fallback. Doesn't shorten — each caller applies its own length limit.
 *
 * Shared by the Postgres "New schema" fold (`foldNameToPostgresSchemaIdentifier`) and the
 * `'lowercaseSqlIdentifier'` {@link NameStyle} for tables and fields, so a schema and the tables in it
 * follow one rule.
 */
export function foldNameToLowercaseSqlIdentifier(name: string, leadingDigitPrefix: string): string {
  const foldedName = name
    .normalize('NFKD')
    // Drop combining marks so "Café" folds to "cafe" rather than losing the é entirely.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (foldedName === '') return '';
  return /^[0-9]/.test(foldedName) ? `${leadingDigitPrefix}${foldedName}` : foldedName;
}

/** A character above U+FFFF, with any zero-width joiners and variation selectors around it. */
const SUPPLEMENTARY_CHARACTER_RUN = /(?:\u200d|\ufe0e|\ufe0f)*(?:[\u{10000}-\u{10ffff}](?:\u200d|\ufe0e|\ufe0f)*)+/u;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/**
 * `name` with the characters `rules` forbid removed, so the destination can create it (DEV-12413). Each run of
 * forbidden characters, with the spaces around it, becomes one space, and the result is trimmed:
 * `Mood 😀` → `Mood`, `Hot 🔥 Deals` → `Hot Deals`, `First\nName` → `First Name`. An emoji run also takes the
 * zero-width joiners and variation selectors attached to it, so a family emoji leaves nothing invisible behind.
 * A name left empty becomes `fallbackName`. Unchanged when `rules` is absent or the name already fits.
 */
export function fitNameToCharacterRules(
  name: string,
  rules: NameCharacterRules | undefined,
  fallbackName: string,
): string {
  if (!rules) return name;
  const forbiddenCharacterRunPattern = buildForbiddenCharacterRunPattern(rules);
  let fittedName = forbiddenCharacterRunPattern ? name.replace(forbiddenCharacterRunPattern, ' ') : name;
  if (fittedName !== name) fittedName = fittedName.replace(/^ +| +$/g, '');
  if (rules.noTrailingSpace) fittedName = fittedName.replace(/ +$/, '');
  return fittedName.trim().length === 0 ? fallbackName : fittedName;
}

/** Matches each run of characters `rules` forbid, with the spaces around it; undefined when none are forbidden. */
function buildForbiddenCharacterRunPattern(rules: NameCharacterRules): RegExp | undefined {
  const forbiddenCharacterPatterns = [
    ...(rules.basicMultilingualPlaneOnly ? [SUPPLEMENTARY_CHARACTER_RUN.source] : []),
    ...(rules.noControlCharacters ? [CONTROL_CHARACTER.source] : []),
  ];
  if (forbiddenCharacterPatterns.length === 0) return undefined;
  return new RegExp(` *(?:${forbiddenCharacterPatterns.join('|')})+ *`, 'gu');
}
