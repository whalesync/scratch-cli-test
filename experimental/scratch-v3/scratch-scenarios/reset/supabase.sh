#!/bin/bash
# Reset Supabase tables to empty state.
# Truncates all test tables in dependency order (children first).

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
source "$SCRIPT_DIR/.env"

SUPA_HEADERS=(-H "apikey: $SUPA_KEY" -H "Authorization: Bearer $SUPA_KEY" -H "Content-Type: application/json" -H "Prefer: return=minimal")

echo "Resetting Supabase..."

# Delete in FK order: children before parents
for table in posts pages products authors tags; do
    # PostgREST: DELETE with no filter = delete all (need to allow via RLS or service key)
    status=$(curl -s -o /dev/null -w "%{http_code}" -X DELETE \
        "${SUPA_HEADERS[@]}" \
        "$SUPA_URL/rest/v1/$table?id=not.is.null")
    echo "  Truncated $table (HTTP $status)"
done

echo "Supabase reset complete."
