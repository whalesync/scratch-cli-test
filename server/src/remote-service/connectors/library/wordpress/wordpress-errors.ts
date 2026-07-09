// WordPress connector pagination errors.
//
// Both are thrown by `pullRecordFiles` when it detects that a WordPress site
// cannot be paginated to completion. Per the product principle "Surface
// failures; never silently succeed" (root `CLAUDE.md`), the connector fails the
// pull with a clear message rather than reporting success with incomplete data.
// They are plain `Error` subclasses (mirroring the generic-api `apiget`
// `MaxPagesReachedError`): the message is service-agnostic on purpose, since
// `WordPressConnector.extractConnectorErrorDetails` → `fallbackErrorDetails`
// prefixes it with the service name (surfacing as "WordPress error: …").

/**
 * Thrown when a WordPress site returns the **same** record ids at a higher
 * `offset` than the previous page — proof it is ignoring the `offset`
 * pagination parameter (confirmed live on a real customer's `categories`
 * endpoint, DEV-10730/DEV-10733). A correctly paginating endpoint never repeats
 * a page at a higher offset, so this is an unambiguous signal that the pull
 * cannot fetch the remaining records and would otherwise loop forever.
 */
export class WordPressOffsetIgnoredError extends Error {
  constructor(
    public readonly tableId: string,
    public readonly offset: number,
  ) {
    super(
      `The WordPress site returned the same records at offset ${offset} as the previous page for "${tableId}", ` +
        `so it is ignoring the "offset" pagination parameter. The pull was stopped because it cannot fetch the ` +
        `remaining records — this is a known defect on some WordPress sites/plugins.`,
    );
    this.name = 'WordPressOffsetIgnoredError';
  }
}

/**
 * Thrown when a pull reaches the {@link WORDPRESS_MAX_PULL_PAGES} page backstop
 * without a clean completion — the safety net for a site that ignores `offset`
 * AND omits the `X-WP-Total` header (so neither the offset-ignoring nor the
 * total check can terminate the loop earlier).
 */
export class WordPressMaxPagesReachedError extends Error {
  constructor(
    public readonly tableId: string,
    public readonly maxPages: number,
  ) {
    super(
      `Hit the ${maxPages}-page pagination backstop while pulling "${tableId}". The site appears to ignore the ` +
        `"offset" parameter and does not report a total ("X-WP-Total" header), so the pull was stopped to avoid ` +
        `an unbounded loop.`,
    );
    this.name = 'WordPressMaxPagesReachedError';
  }
}
