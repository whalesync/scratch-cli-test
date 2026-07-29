// WordPress connector constants

export const WORDPRESS_POLLING_PAGE_SIZE = 100;
export const WORDPRESS_STATUS_COLUMN_ID = 'status';

// Runaway-pagination backstop for `pullRecordFiles`: the maximum number of
// pages a single pull will fetch before it gives up and fails. This is NOT a
// usage cap — a healthy site completes far earlier via the short-page check or
// the `X-WP-Total` (`offset >= total`) check. It only exists to guarantee
// termination when a site both ignores the `offset` param AND omits the
// `X-WP-Total` header (so the offset-ignoring / total checks can't catch it).
// At 100 records/page this covers 100k records before the backstop trips.
export const WORDPRESS_MAX_PULL_PAGES = 1000;

// Last-modified field exposed by post-type and media collections (in the
// site's timezone). Taxonomy collections (categories/tags/terms) do NOT expose
// this field, so they have no incremental-pull support and demote to a full
// scan. Used to gate the `x-scratch-last-modified-field` schema annotation.
export const WORDPRESS_MODIFIED_COLUMN_ID = 'modified';

// WordPress batch API supports up to 25 requests per batch (default server limit)
export const WORDPRESS_BATCH_SIZE = 25;

// Timeout for media upload requests (2 minutes)
export const WORDPRESS_UPLOAD_TIMEOUT_MS = 120_000;

// ACF (Advanced Custom Fields) support
export const WORDPRESS_REMOTE_CUSTOM_FIELDS_ID = 'acf';
export const WORDPRESS_ORG_V2_PATH = 'wp/v2/';

// Tables to exclude from listing
export const WORDPRESS_EXCLUDE_TABLE_SLUGS = [
  'nav_menu_item',
  'wp_block',
  'wp_template',
  'wp_template_part',
  'wp_global_styles',
  'wp_navigation',
  'wp_font_family',
  'wp_font_face',
  'users',
];

// Tables that don't support create operations
export const WORDPRESS_CREATE_UNSUPPORTED_TABLE_IDS = ['media', 'users'];

// Tables whose WordPress REST route does NOT opt into the batch controller
// (POST /batch/v1). WordPress only batches routes that register
// `allow_batch => array('v1' => true)`; the media route (/wp/v2/media) does
// not, so issuing media update/delete through a batch is rejected with
// "The requested route does not support batch requests." Publish falls back to
// individual per-record requests for these tables.
export const WORDPRESS_BATCH_UNSUPPORTED_TABLE_IDS = ['media'];

// (Removed: WORDPRESS_HIDDEN_COLUMN_IDS / WORDPRESS_EXCLUDE_COLUMN_ID_SUBSTRINGS. They fed
// the legacy column-list path deleted in a4403b29b and had no remaining reader, so they
// described nothing — while actively misleading: they listed `parent` and every `*_gmt`
// column as hidden, which is now the opposite of what this connector does. Column hiding
// lives in `HIDDEN_FIELDS` in wordpress-default-view.ts, on the VIEW, not the schema.)

// Taxonomy slugs to exclude from discovery (internal WordPress taxonomies)
export const WORDPRESS_EXCLUDE_TAXONOMY_SLUGS = [
  'nav_menu',
  'link_category',
  'post_format',
  'wp_theme',
  'wp_template_type',
  'wp_template_part_area',
  'wp_pattern_category',
];

// The `rest_base` — and therefore the Scratch table id — of the attachment post type.
export const WORDPRESS_MEDIA_TABLE_ID = 'media';

// The self-referential parent column exposed by HIERARCHICAL post types (Pages) and
// hierarchical taxonomies (Categories).
export const WORDPRESS_PARENT_COLUMN_ID = 'parent';

// WordPress's sentinel for "this link is empty": it writes `0` rather than null on a post
// with no featured image (`featured_media`) or a top-level page/category (`parent`). Real
// WordPress ids start at 1, so `0` is never a resolvable reference.
export const WORDPRESS_NO_LINK_FOREIGN_KEY_VALUE = 0;

// Static foreign key relationships (taxonomy FKs, and the self-referential `parent` on
// hierarchical collections, are discovered dynamically)
export const WORDPRESS_STATIC_FOREIGN_KEY_COLUMN_IDS: { remoteColumnId: string; foreignKeyRemoteTableId: string }[] = [
  { remoteColumnId: 'author', foreignKeyRemoteTableId: 'users' },
  // A post's featured image is the id of a record in the Media table — a relation, not a
  // number. Left undeclared it exported as a bare integer and the link to the image was
  // lost on every destination (DEV-11093).
  { remoteColumnId: 'featured_media', foreignKeyRemoteTableId: WORDPRESS_MEDIA_TABLE_ID },
];
