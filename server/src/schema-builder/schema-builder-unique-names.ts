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
 * Return `requestedName` unchanged when its normalized form is not already in
 * `takenNormalizedNames`; otherwise return the first free `"requestedName 2"`,
 * `"requestedName 3"`, … The normalized form of the chosen name is added to the
 * set so the next call sees it. Cascading-collision safe: a candidate suffix
 * that is itself already taken is skipped.
 *
 * The caller compares the returned name to `requestedName` to detect a rename.
 * The first duplicate gets suffix `2` (the original keeps its bare name).
 */
export function allocateUniqueName(requestedName: string, takenNormalizedNames: Set<string>): string {
  if (!takenNormalizedNames.has(normalizeNameForUniqueness(requestedName))) {
    takenNormalizedNames.add(normalizeNameForUniqueness(requestedName));
    return requestedName;
  }
  let suffix = 2;
  let candidate = `${requestedName} ${suffix}`;
  while (takenNormalizedNames.has(normalizeNameForUniqueness(candidate))) {
    suffix += 1;
    candidate = `${requestedName} ${suffix}`;
  }
  takenNormalizedNames.add(normalizeNameForUniqueness(candidate));
  return candidate;
}
