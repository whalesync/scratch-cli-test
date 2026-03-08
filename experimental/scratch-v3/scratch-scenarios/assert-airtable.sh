#!/bin/bash
# Assert Airtable data matches expected state.
# Usage: ./assert-airtable.sh [expected-file]
#
# Reads from the Airtable API and compares against expected JSON.
# Uses jq to normalize and sort for stable comparison.

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a; source "$SCRIPT_DIR/.env"; set +a

EXPECTED="${1:-$SCRIPT_DIR/expected/airtable.json}"
ACTUAL=$(mktemp)
trap 'rm -f "$ACTUAL"' EXIT

API="https://api.airtable.com/v0/$AIRTABLE_BASE_ID"
AUTH="Authorization: Bearer $AIRTABLE_TOKEN"

fetch_table() {
    local table_id="$1"
    local name="$2"
    curl -s "$API/$table_id" -H "$AUTH" | jq --arg name "$name" '{
        ($name): [.records[] | {id: .id, fields: .fields}]
    }'
}

# Fetch all tables and merge into one object
tags=$(fetch_table "$AIRTABLE_TAGS_TABLE_ID" "tags")
authors=$(fetch_table "$AIRTABLE_AUTHORS_TABLE_ID" "authors")
posts=$(fetch_table "$AIRTABLE_POSTS_TABLE_ID" "posts")
pages=$(fetch_table "$AIRTABLE_PAGES_TABLE_ID" "pages")
products=$(fetch_table "$AIRTABLE_PRODUCTS_TABLE_ID" "products")

# Merge and normalize — strip volatile fields (attachment thumbnails, sizes, etc.)
echo "$tags $authors $posts $pages $products" | jq -s '
    reduce .[] as $item ({}; . + $item) |
    # Normalize: sort records in each table by first text field
    .tags |= sort_by(.fields.Name) |
    .authors |= sort_by(.fields.Name) |
    .posts |= sort_by(.fields.Title) |
    .pages |= sort_by(.fields.Title) |
    .products |= sort_by(.fields.Name) |
    # Strip volatile attachment metadata (thumbnails change, sizes vary)
    walk(if type == "object" and .url and .filename then {url: .url, filename: .filename} else . end)
' > "$ACTUAL"

if diff <(jq -S . "$EXPECTED") <(jq -S . "$ACTUAL") > /dev/null 2>&1; then
    echo "PASS  airtable state matches expected"
else
    echo "FAIL  airtable state differs from expected"
    diff --color <(jq -S . "$EXPECTED") <(jq -S . "$ACTUAL") || true
    exit 1
fi
