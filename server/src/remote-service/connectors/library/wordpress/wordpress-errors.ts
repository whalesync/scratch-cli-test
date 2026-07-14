// WordPress connector pagination errors.
//
// Both are thrown by `pullRecordFiles` when it detects that a WordPress site
// cannot be paginated to completion (the connector paginates by `page`, see
// DEV-10786). Per the product principle "Surface failures; never silently
// succeed" (root `CLAUDE.md`), the connector fails the pull with a clear message
// rather than reporting success with incomplete data.
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
