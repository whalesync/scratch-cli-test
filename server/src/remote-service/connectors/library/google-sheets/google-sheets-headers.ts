import { GoogleSheetsError, SCRATCH_ID_COLUMN_HEADER, SCRATCH_ID_RECORD_KEY } from './google-sheets-types';

/**
 * Header → field-key slugging for the Google Sheets connector.
 *
 * Row 1 is always the header row; a field's key in record files is the
 * slugified header. Consequences (deliberate, per the connector design):
 *   - REORDERING columns changes nothing (keys don't encode position).
 *   - RENAMING a header creates a NEW field (and the old one disappears).
 *   - Two headers that slugify identically are an error the user must fix —
 *     we fail fast rather than invent `_2` suffixes that would silently
 *     reshuffle onto different columns after a reorder.
 */

/**
 * Slugify a header cell into a record field key: lowercase, runs of anything
 * non-alphanumeric collapse to `_`, trimmed of leading/trailing `_`.
 * Returns '' for headers with no alphanumeric content (treated as unheadered).
 */
export function slugifyHeaderToFieldKey(header: string): string {
  return header
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * Map raw header texts (excluding the ID column) to slugs, skipping empty /
 * non-sluggable headers, and failing loudly on collisions.
 *
 * @param headers Parallel to grid columns: `headers[i]` is the header text of
 *   grid column `columnIndexOffset + i`.
 * @returns One entry per headed column, in grid order: `{ header, slug, columnIndex }`.
 * @throws GoogleSheetsError naming the colliding headers when two slugify identically.
 */
export function mapHeadersToFieldKeys(
  headers: (string | undefined)[],
  columnIndexOffset: number,
): { header: string; slug: string; columnIndex: number }[] {
  const mappedColumns: { header: string; slug: string; columnIndex: number }[] = [];
  const headersBySlug = new Map<string, string>();

  headers.forEach((rawHeader, offsetIndex) => {
    const header = (rawHeader ?? '').trim();
    if (header === '') return; // Unheadered columns are ignored entirely (not pulled, not published).
    const slug = slugifyHeaderToFieldKey(header);
    if (slug === '') return;

    // `scratch_id` is the managed ID column's record key. A DATA column whose
    // header slugifies to it (a stray "Scratch ID" column in the wrong
    // position, or any header like "scratch-id") would silently overwrite
    // every record's remote id — fail fast instead.
    if (slug === SCRATCH_ID_RECORD_KEY) {
      throw new GoogleSheetsError(
        `The column header "${header}" collides with Scratch's reserved "${SCRATCH_ID_COLUMN_HEADER}" field. ` +
          `Only column A may be the ${SCRATCH_ID_COLUMN_HEADER} column — rename (or remove) this column in Google Sheets.`,
        400,
      );
    }

    const collidingHeader = headersBySlug.get(slug);
    if (collidingHeader !== undefined && collidingHeader !== header) {
      throw new GoogleSheetsError(
        `Two column headers ("${collidingHeader}" and "${header}") both map to the field key "${slug}". ` +
          'Rename one of them in Google Sheets so every column has a distinct name.',
        400,
      );
    }
    if (collidingHeader !== undefined) {
      throw new GoogleSheetsError(
        `The column header "${header}" appears more than once. ` +
          'Rename one of the duplicate columns in Google Sheets so every column has a distinct name.',
        400,
      );
    }
    headersBySlug.set(slug, header);
    mappedColumns.push({ header, slug, columnIndex: columnIndexOffset + offsetIndex });
  });

  return mappedColumns;
}
