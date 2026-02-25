// WordPress connector constants

export const WORDPRESS_POLLING_PAGE_SIZE = 100;

// WordPress batch API supports up to 25 requests per batch (default server limit)
export const WORDPRESS_BATCH_SIZE = 25;

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
  'attachment', // Media has the slug "attachment"
  'users',
];

// Tables that don't support create operations
export const WORDPRESS_CREATE_UNSUPPORTED_TABLE_IDS = ['media', 'users'];

// Columns to hide from the schema
export const WORDPRESS_HIDDEN_COLUMN_IDS = [
  'id',
  'meta',
  'parent',
  'post',
  'guid',
  'type',
  'class_list',
  'comment_status',
  'generated_slug',
];

// Column ID substrings to exclude
export const WORDPRESS_EXCLUDE_COLUMN_ID_SUBSTRINGS = ['gmt', 'template', 'capabilities'];

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

// Static foreign key relationships (taxonomy FKs are discovered dynamically)
export const WORDPRESS_STATIC_FOREIGN_KEY_COLUMN_IDS: { remoteColumnId: string; foreignKeyRemoteTableId: string }[] = [
  { remoteColumnId: 'author', foreignKeyRemoteTableId: 'users' },
];
