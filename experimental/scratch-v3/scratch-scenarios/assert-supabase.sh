#!/bin/bash
# Assert Supabase content matches expected state.
# Usage: ./assert-supabase.sh [expected-file]
#
# Curls the Supabase REST API (PostgREST) and compares against expected JSON.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/.env"

EXPECTED="${1:-$SCRIPT_DIR/expected/supabase.json}"
ACTUAL=$(mktemp)
trap 'rm -f "$ACTUAL"' EXIT

SUPA_HEADERS=(-H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY")

# Fetch each table, normalize for comparison
tags=$(curl -s "${SUPA_HEADERS[@]}" "$SUPA_URL/rest/v1/tags?order=slug" | jq '
    [.[] | {name, slug}]
')

authors=$(curl -s "${SUPA_HEADERS[@]}" "$SUPA_URL/rest/v1/authors?order=name" | jq '
    [.[] | {name, has_avatar: (.avatar_url // null | . != null)}]
')

posts=$(curl -s "${SUPA_HEADERS[@]}" "$SUPA_URL/rest/v1/posts?select=*,tags(*),authors(*)&order=slug" | jq '
    [.[] | {
        title,
        slug,
        tag_count: (.tags | length),
        author: (.authors.name // null),
        has_image: (.featured_image_url // null | . != null)
    }]
')

pages=$(curl -s "${SUPA_HEADERS[@]}" "$SUPA_URL/rest/v1/pages?order=slug" | jq '
    [.[] | {title, slug, has_parent: (.parent_id // null | . != null)}]
')

products=$(curl -s "${SUPA_HEADERS[@]}" "$SUPA_URL/rest/v1/products?order=name" | jq '
    [.[] | {name, price, color, in_stock, rating}]
')

jq -n \
    --argjson tags "$tags" \
    --argjson authors "$authors" \
    --argjson posts "$posts" \
    --argjson pages "$pages" \
    --argjson products "$products" \
    '{tags: $tags, authors: $authors, posts: $posts, pages: $pages, products: $products}' > "$ACTUAL"

if diff <(jq -S . "$EXPECTED") <(jq -S . "$ACTUAL") > /dev/null 2>&1; then
    echo "PASS  supabase state matches expected"
else
    echo "FAIL  supabase state differs from expected"
    diff --color <(jq -S . "$EXPECTED") <(jq -S . "$ACTUAL") || true
    exit 1
fi
