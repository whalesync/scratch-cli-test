// WordPress connector pagination errors.
//
// All three are raised when a WordPress site cannot be paginated to completion
// (the connector paginates by `page`, see DEV-10786):
// `WordPressPageIgnoredError` and `WordPressMaxPagesReachedError` are thrown by
// `pullRecordFiles` (the loop safeguards), and `WordPressInvalidFirstPageError`
// is thrown by the HTTP client's `pollRecords` (the page-1 guard, DEV-10912) —
// it propagates out of `pullRecordFiles`, which does not catch it. Per the
// product principle "Surface failures; never silently succeed" (root
// `CLAUDE.md`), the connector fails the pull with a clear message rather than
// reporting success with incomplete data.
// They are plain `Error` subclasses (mirroring the generic-api `apiget`
// `MaxPagesReachedError`): the message is service-agnostic on purpose, since
// `WordPressConnector.extractConnectorErrorDetails` → `fallbackErrorDetails`
// prefixes it with the service name (surfacing as "WordPress error: …").

/**
 * Thrown when a WordPress site returns the **same** record ids at a higher
 * `page` than the previous page — proof it is ignoring the `page` pagination
 * parameter. The connector paginates by `page` (DEV-10786), which works on the
 * offset-ignoring endpoints seen live (a real customer's `categories` endpoint,
 * DEV-10730/DEV-10733); this guard is the fail-loud net for the rarer site that
 * ignores `page` too. A correctly paginating endpoint never repeats a page at a
 * higher page number, so this is an unambiguous signal that the pull cannot
 * fetch the remaining records and would otherwise loop forever.
 */
export class WordPressPageIgnoredError extends Error {
  constructor(
    public readonly tableId: string,
    public readonly page: number,
  ) {
    super(
      `The WordPress site returned the same records at page ${page} as the previous page for "${tableId}", ` +
        `so it is ignoring the "page" pagination parameter. The pull was stopped because it cannot fetch the ` +
        `remaining records — this is a known defect on some WordPress sites/plugins.`,
    );
    this.name = 'WordPressPageIgnoredError';
  }
}

/**
 * Thrown when a pull reaches the {@link WORDPRESS_MAX_PULL_PAGES} page backstop
 * without a clean completion — the safety net for a site that ignores `page`
 * AND omits the `X-WP-Total` / `X-WP-TotalPages` headers (so neither the
 * page-ignoring nor the total-pages check can terminate the loop earlier).
 */
export class WordPressMaxPagesReachedError extends Error {
  constructor(
    public readonly tableId: string,
    public readonly maxPages: number,
  ) {
    super(
      `Hit the ${maxPages}-page pagination backstop while pulling "${tableId}". The site appears to ignore the ` +
        `"page" parameter and does not report a total ("X-WP-Total" header), so the pull was stopped to avoid ` +
        `an unbounded loop.`,
    );
    this.name = 'WordPressMaxPagesReachedError';
  }
}

/**
 * Thrown when the **first** page of a pull returns `400 *_invalid_page_number`
 * (DEV-10912). Stock WordPress cannot 400 on page 1: an empty table returns
 * `200 []`, and the "invalid page number" rejection only fires past the last
 * page (which requires `total > 0`). So a page-1 400 means a plugin is
 * overriding pagination and reporting the whole collection as out of range.
 * Treating it as a clean end-of-collection (as pages ≥ 2 are) would complete
 * the scan over **zero** records, and — sustained across the delete buffer —
 * let the delete detector tombstone every previously-synced record in the
 * table. We abort the pull instead. The exact-multiple-of-`per_page` boundary
 * (a 400 at page ≥ 2) still completes cleanly.
 */
export class WordPressInvalidFirstPageError extends Error {
  constructor(public readonly tableId: string) {
    super(
      `The WordPress site returned "invalid page number" on page 1 for "${tableId}", which stock WordPress ` +
        `never does on a non-empty table (an empty table returns an empty page, and the error only fires past ` +
        `the last page). A plugin is overriding pagination and reporting the collection as out of range, so the ` +
        `pull was stopped rather than completing over zero records — this is a known defect on some WordPress ` +
        `sites/plugins.`,
    );
    this.name = 'WordPressInvalidFirstPageError';
  }
}
