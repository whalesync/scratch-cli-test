#!/bin/bash
# Reset WordPress to a clean state — delete all posts, pages, categories, media.
# Requires WP-CLI or Application Passwords for REST API access.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$SCRIPT_DIR/.env"; set +a

wp_curl() {
    curl -s --user "$WP_USER:$WP_APP_PASSWORD" "$@"
}

echo "Resetting WordPress..."

# Delete all posts
post_ids=$(wp_curl "$WP_URL/wp-json/wp/v2/posts?per_page=100&status=any" | jq -r '.[].id')
for id in $post_ids; do
    wp_curl -X DELETE "$WP_URL/wp-json/wp/v2/posts/$id?force=true" > /dev/null
done
echo "  Deleted $(echo "$post_ids" | grep -c . || echo 0) posts"

# Delete all pages
page_ids=$(wp_curl "$WP_URL/wp-json/wp/v2/pages?per_page=100&status=any" | jq -r '.[].id')
for id in $page_ids; do
    wp_curl -X DELETE "$WP_URL/wp-json/wp/v2/pages/$id?force=true" > /dev/null
done
echo "  Deleted $(echo "$page_ids" | grep -c . || echo 0) pages"

# Delete all categories (except default "Uncategorized" which can't be deleted)
cat_ids=$(wp_curl "$WP_URL/wp-json/wp/v2/categories?per_page=100" | jq -r '.[] | select(.slug != "uncategorized") | .id')
for id in $cat_ids; do
    wp_curl -X DELETE "$WP_URL/wp-json/wp/v2/categories/$id?force=true" > /dev/null
done
echo "  Deleted $(echo "$cat_ids" | grep -c . || echo 0) categories"

# Delete all media
media_ids=$(wp_curl "$WP_URL/wp-json/wp/v2/media?per_page=100" | jq -r '.[].id')
for id in $media_ids; do
    wp_curl -X DELETE "$WP_URL/wp-json/wp/v2/media/$id?force=true" > /dev/null
done
echo "  Deleted $(echo "$media_ids" | grep -c . || echo 0) media items"

echo "WordPress reset complete."
