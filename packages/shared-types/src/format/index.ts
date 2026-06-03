/**
 * Serializes a value to Scratch's canonical on-disk JSON format: 2-space
 * indentation with a single trailing newline.
 *
 * This is the one definition of how a JSON file is written to a workbook repo —
 * records, schemas, views, and configs alike — shared by the server's git
 * commits and the desktop app's local writes so the two can never drift
 * byte-for-byte (a mismatch shows up as spurious diffs and breaks round-trip
 * fidelity). The scratchmd Rust CLI (`json_object_to_bytes`) implements the same
 * contract independently; both sides are pinned by tests.
 *
 * Exported from the package barrel (`@spinner/shared-types`) for Node consumers
 * and from the lean `@spinner/shared-types/format` subpath for bundlers that want
 * just this function without the rest of the barrel.
 */
export function formatRecordJson(data: unknown): string {
  return JSON.stringify(data, null, 2) + '\n';
}
