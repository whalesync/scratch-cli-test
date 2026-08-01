/**
 * Helpers for the GROQ modified-since predicate used by incremental pulls.
 * Mirrors the module shape of `linear/linear-incremental.ts` — the mechanism here
 * is a server-side GROQ clause on the service-guaranteed `_updatedAt` system field.
 *
 * The comparison uses `dateTime()` on both sides rather than raw string comparison:
 * Sanity emits `_updatedAt` at seconds precision (`...T04:48:08Z`) while our
 * watermark ISO string carries milliseconds, and lexicographic comparison across
 * those two shapes is not reliable at the boundary.
 */

/**
 * Clock-skew safety margin subtracted from the watermark. The predicate is
 * inclusive (`>=`) but the watermark is captured on the worker's clock while
 * `_updatedAt` is written by Sanity's servers, so a boundary record could be
 * missed under drift without an overlap. The margin re-pulls a small window each
 * run; idempotent commits absorb the duplicates.
 */
export const SANITY_INCREMENTAL_CLOCK_SKEW_MS = 60_000;

/**
 * The GROQ clause ANDed into the pagination query on an incremental pull. The
 * cutoff itself rides as the `$since` query param (see
 * {@link buildSanityIncrementalSinceParam}) — never string-interpolated.
 */
export const SANITY_INCREMENTAL_GROQ_CLAUSE = 'dateTime(_updatedAt) >= dateTime($since)';

/** The `$since` param value: the watermark minus the clock-skew margin, as ISO 8601. */
export function buildSanityIncrementalSinceParam(since: Date): string {
  return new Date(since.getTime() - SANITY_INCREMENTAL_CLOCK_SKEW_MS).toISOString();
}
