import type { NameLengthUnit } from '@spinner/shared-types';
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
 * `"requestedName 3"`, … The normalized form of the chosen name is added to the
 * set so the next call sees it. Cascading-collision safe: a candidate suffix that
 * is itself already taken is skipped.
 *
 * When `maxLength` is given, every returned name is guaranteed to fit within it
 * (measured in `lengthUnit`, characters by default): the bare name is elided to
 * `maxLength`, and a suffixed candidate elides the base to leave room for its ` N`
 * suffix, so `base + " N"` still fits.
 *
 * The caller compares the returned name to `elideNameToMaxLength(requestedName,
 * maxLength, lengthUnit)` to detect a dedup rename, and to `requestedName` to detect
 * elision. The first duplicate gets suffix `2` (the original keeps its bare, elided name).
 */
export function allocateUniqueName(
  requestedName: string,
  takenNormalizedNames: Set<string>,
  maxLength?: number,
  lengthUnit: NameLengthUnit = 'characters',
): string {
  const elidedName = elideNameToMaxLength(requestedName, maxLength, lengthUnit);
  if (!takenNormalizedNames.has(normalizeNameForUniqueness(elidedName))) {
    takenNormalizedNames.add(normalizeNameForUniqueness(elidedName));
    return elidedName;
  }
  let suffix = 2;
  let candidate = buildSuffixedCandidate(requestedName, suffix, maxLength, lengthUnit);
  while (takenNormalizedNames.has(normalizeNameForUniqueness(candidate))) {
    suffix += 1;
    candidate = buildSuffixedCandidate(requestedName, suffix, maxLength, lengthUnit);
  }
  takenNormalizedNames.add(normalizeNameForUniqueness(candidate));
  return candidate;
}

/** `requestedName` middle-elided to `maxLength` (in `lengthUnit`), or unchanged when no limit is given. */
export function elideNameToMaxLength(
  requestedName: string,
  maxLength?: number,
  lengthUnit: NameLengthUnit = 'characters',
): string {
  return maxLength === undefined ? requestedName : elideToMaxLength(requestedName, maxLength, { lengthUnit });
}

/**
 * `"<base> <suffix>"` where the base is elided so the whole candidate fits within
 * `maxLength` (the ` <suffix>` is reserved first, measured in `lengthUnit`). With no
 * limit the base is used verbatim.
 */
function buildSuffixedCandidate(
  requestedName: string,
  suffix: number,
  maxLength: number | undefined,
  lengthUnit: NameLengthUnit,
): string {
  const suffixString = ` ${suffix}`;
  if (maxLength === undefined) return `${requestedName}${suffixString}`;
  const base = elideToMaxLength(requestedName, Math.max(0, maxLength - measureTextLength(suffixString, lengthUnit)), {
    lengthUnit,
  });
  return `${base}${suffixString}`;
}
