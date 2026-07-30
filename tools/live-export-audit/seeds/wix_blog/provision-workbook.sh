#!/usr/bin/env bash
# Provision one audit workbook for an OAuth-only source (Wix Blog) + one destination.
#
# Wix Blog has no user-provided credential params, so the audit harness cannot create its
# source connection. Connections are also workbook-scoped (a cross-workbook GET 404s), and the
# harness needs one workbook per destination so `--rerun` targets the right sync. So we clone the
# one human-connected Wix ConnectorAccount row into a fresh workbook per destination — its
# encryptedCredentials blob is self-contained (Wix instanceId + app access token), so a row copy
# is all it takes.
#
# Usage: provision-workbook.sh <DEST_SERVICE> <new coa_ id for the cloned Wix connection>
#   e.g. provision-workbook.sh NOTION coa_qaWixNot2
# Prints: "<workbookId> <wixConnectionId> <destConnectionId>"
set -euo pipefail

DEST="$1"
NEW_WIX_CONNECTION_ID="$2"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
CREDS_DIR="$REPO_ROOT/local/audit-creds"
SOURCE_CONNECTION_TO_CLONE="${WIX_SOURCE_CONNECTION:-coa_OFBt3xqMf0}"
# Honour SPINNER_API_URL so a parallel session (server on 3010+N, running its own worktree's branch
# code) can be provisioned against instead of the shared default stack.
API="${SPINNER_API_URL:-http://localhost:3010}"
TOKEN="$(grep SPINNER_API_TOKEN "$CREDS_DIR/_spinner.env" | cut -d= -f2)"

workbook_id="$(curl -s -X POST -H "Authorization: API-Token $TOKEN" -H 'Content-Type: application/json' \
  "$API/workbook" -d "{\"name\":\"QA WIX_BLOG -> $DEST\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"

# Clone the Wix source connection into the new workbook.
PGPASSWORD=postgres psql -q -h localhost -p 5432 -U postgres -d scratchpaper >/dev/null <<SQL
INSERT INTO "ConnectorAccount"
  (id, "createdAt", "updatedAt", "userId", "workbookId", service, "displayName", "authType",
   "repoPath", "encryptedCredentials", "healthStatus", "healthStatusLastCheckedAt",
   "healthStatusMessage", modifier, extras, version, "oauthAppVersion")
SELECT '$NEW_WIX_CONNECTION_ID', now(), now(), src."userId", '$workbook_id', src.service,
  'qa-source-WIX_BLOG', src."authType",
  (SELECT "organizationId" FROM "Workbook" WHERE id = '$workbook_id') || '/$workbook_id/$NEW_WIX_CONNECTION_ID',
  src."encryptedCredentials", src."healthStatus", src."healthStatusLastCheckedAt",
  src."healthStatusMessage", src.modifier, src.extras, src.version, src."oauthAppVersion"
FROM "ConnectorAccount" src WHERE src.id = '$SOURCE_CONNECTION_TO_CLONE';
SQL

# Create the destination connection from its gitignored creds file. DEST_PARENT_ID is an
# audit-only key, not a connector param, so it is stripped from userProvidedParams.
dest_connection_body="$(mktemp)"
python3 - "$CREDS_DIR/$(echo "$DEST" | tr '[:upper:]' '[:lower:]').env" "$DEST" > "$dest_connection_body" <<'PY'
import json, re, sys
params = {}
for line in open(sys.argv[1]):
    m = re.match(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$', line)
    if m and m.group(1) != 'DEST_PARENT_ID':
        params[m.group(1)] = m.group(2).strip('"\'')
print(json.dumps({'service': sys.argv[2], 'authType': 'API_KEY', 'userProvidedParams': params,
                  'displayName': 'qa-dest-' + sys.argv[2]}))
PY
dest_connection_id="$(curl -s -X POST -H "Authorization: API-Token $TOKEN" -H 'Content-Type: application/json' \
  "$API/workbooks/$workbook_id/connections" -d @"$dest_connection_body" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])')"
rm -f "$dest_connection_body"

for connection_id in "$NEW_WIX_CONNECTION_ID" "$dest_connection_id"; do
  health="$(curl -s -X POST -H "Authorization: API-Token $TOKEN" -H 'Content-Type: application/json' \
    "$API/workbooks/$workbook_id/connections/$connection_id/test" -d '{}')"
  echo "  $connection_id health: $health" >&2
done

echo "$workbook_id $NEW_WIX_CONNECTION_ID $dest_connection_id"
