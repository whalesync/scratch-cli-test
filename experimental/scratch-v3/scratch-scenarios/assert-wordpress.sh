#!/bin/bash
# Assert WordPress content matches expected state.
# Usage: ./assert-wordpress.sh [expected-file]
#
# Curls the WP REST API and compares against expected JSON.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; source "$SCRIPT_DIR/.env"; set +a

EXPECTED="${1:-$SCRIPT_DIR/expected/wordpress.json}"
ACTUAL=$(mktemp)
trap 'rm -f "$ACTUAL"' EXIT

wp_curl() {
    curl -s --user "$WP_USER:$WP_APP_PASSWORD" "$@"
}

# Fetch categories (excluding "Uncategorized" which WP creates by default)
categories=$(wp_curl "$WP_URL/wp-json/wp/v2/categories?per_page=100" | jq '
    [.[] | select(.slug != "uncategorized") | {name, slug, count}] | sort_by(.slug)
')

# Fetch posts
posts=$(wp_curl "$WP_URL/wp-json/wp/v2/posts?per_page=100" | jq '
    [.[] | {
        title: .title.rendered,
        slug,
        has_featured_image: (.featured_media > 0),
        status
    }] | sort_by(.slug)
')

# Fetch pages
pages=$(wp_curl "$WP_URL/wp-json/wp/v2/pages?per_page=100" | jq '
    [.[] | {
        title: .title.rendered,
        slug,
        has_parent: (.parent > 0),
        status
    }] | sort_by(.slug)
')

# Combine
jq -n \
    --argjson categories "$categories" \
    --argjson posts "$posts" \
    --argjson pages "$pages" \
    '{categories: $categories, posts: $posts, pages: $pages}' > "$ACTUAL"

if diff <(jq -S . "$EXPECTED") <(jq -S . "$ACTUAL") > /dev/null 2>&1; then
    echo "PASS  wordpress state matches expected"
else
    echo "FAIL  wordpress state differs from expected"
    diff --color <(jq -S . "$EXPECTED") <(jq -S . "$ACTUAL") || true
    exit 1
fi
