#!/usr/bin/env bash
# =============================================================================
# Bootstrap a POPULATED workspace in the test account by connecting an API-KEY
# (non-OAuth) connector, so the desktop QA has real data to download / edit /
# publish. OAuth connectors need a browser — out of scope here.
#
# API keys come from server/.env.integration; the Scratch token from
# scratch-desktop/.env.e2e. Everything is created server-side on test-api against
# the test account; the desktop app then downloads the workspace.
#
# Usage:
#   .claude/skills/qa-desktop-app/setup-connection.sh <SERVICE> <KEY_ENV_VAR> [workspace_name] [table_id...]
#
# Examples (SERVICE must be one of `scratchmd connections add --service`'s enum):
#   setup-connection.sh AIRTABLE  AIRTABLE_API_KEY
#   setup-connection.sh PIPEDRIVE PIPEDRIVE_API_KEY "QA Pipedrive"
#   setup-connection.sh WEBFLOW   WEBFLOW_API_KEY   "QA Webflow" siteId,collectionId
#
# Idempotent: reuses the workspace (by name), the connection (by service), and
# already-linked tables. Prints the workbook id; then drive the app with:
#   QA_WORKBOOK_ID=<wkb> node .claude/skills/qa-desktop-app/qa-driver.mjs
# =============================================================================
set -euo pipefail

SERVICE="${1:?usage: setup-connection.sh <SERVICE> <KEY_ENV_VAR> [workspace_name] [table_id...]}"
KEY_VAR="${2:?need the env var name in server/.env.integration, e.g. AIRTABLE_API_KEY}"
shift 2
WS_NAME="${1:-QA $SERVICE}"; [ $# -gt 0 ] && shift || true
EXPLICIT_TABLES=("$@")

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
B="$ROOT/scratch-git-2/target/debug/scratchmd"
[ -x "$B" ] || { echo "Build the CLI first:  (cd scratch-git-2 && cargo build --bin scratchmd)"; exit 1; }
export SCRATCH_URL="${SCRATCH_URL:-https://test-api.scratch.md}"
# Isolate CLI creds so we don't clobber the user's real ~/.scratchmd login.
export HOME="$ROOT/.context/qa/cli-home"; mkdir -p "$HOME"

# Sourcing strips the single-quotes the .env files wrap values in.
set -a
[ -f "$ROOT/server/.env.integration" ] && . "$ROOT/server/.env.integration"
[ -f "$ROOT/scratch-desktop/.env.e2e" ] && . "$ROOT/scratch-desktop/.env.e2e"
set +a
KEY="${!KEY_VAR:-}"; [ -n "$KEY" ] || { echo "No \$$KEY_VAR in server/.env.integration"; exit 1; }
TOKEN="${TESTING_ACCOUNT_API_KEY:-}"; [ -n "$TOKEN" ] || { echo "No TESTING_ACCOUNT_API_KEY in scratch-desktop/.env.e2e"; exit 1; }
EMAIL="${TESTING_ACCOUNT_EMAIL:-testing@whalesync.com}"

jq_(){ python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

# Equals-form: the Scratch token starts with '-', which clap would otherwise
# parse as a flag. Use --flag=value for any value that can start with a dash.
"$B" auth set-credentials --apiToken="$TOKEN" --email="$EMAIL" --expiresAt=2099-01-01T00:00:00Z >/dev/null
echo "Authed CLI as $EMAIL on $SCRATCH_URL"

# --- reuse-or-create the workspace (by name) ---------------------------------
WB="$("$B" --json workspaces list | jq_ "next((w['id'] for w in d['workbooks'] if w.get('name')=='$WS_NAME'), '')")"
if [ -z "$WB" ]; then
  WB="$("$B" --json workspaces create "$WS_NAME" | jq_ "d['id']")"
  echo "Created workspace $WB ($WS_NAME)"
else
  echo "Reusing workspace $WB ($WS_NAME)"
fi

# --- reuse-or-create the connection (by service) -----------------------------
CONN_IS_NEW=0
CONN="$("$B" connections --workspace "$WB" list --json | jq_ "next((c['id'] for c in d if c.get('service')=='$SERVICE'), '')")"
if [ -z "$CONN" ]; then
  ADD="$("$B" connections --workspace "$WB" add --service "$SERVICE" --param "apiKey=$KEY" --name "$WS_NAME" --json)"
  CONN="$(echo "$ADD" | jq_ "d['id']")"; CONN_IS_NEW=1
  echo "Connected $SERVICE: $CONN (health $(echo "$ADD" | jq_ "d.get('healthStatus','?')"))"
else
  echo "Reusing $SERVICE connection $CONN"
fi

# --- link tables ONLY for a fresh connection, or when explicitly requested ---
# (linked-table introspection isn't reliable enough to dedup re-links; re-linking
# the same table creates a DUPLICATE folder and double-counts records. So on a
# reused connection we skip linking and just re-pull what's already linked.)
echo "Available tables:"
"$B" linked --workspace "$WB" available "$CONN" --json | python3 -c "import sys,json;[print('  ',t['id'],' ',t.get('displayName')) for t in json.load(sys.stdin)]"
if [ "$CONN_IS_NEW" = 1 ] || [ "${#EXPLICIT_TABLES[@]}" -gt 0 ]; then
  AVAIL="$("$B" linked --workspace "$WB" available "$CONN" --json)"
  if [ "${#EXPLICIT_TABLES[@]}" -gt 0 ]; then TABLES=("${EXPLICIT_TABLES[@]}"); else TABLES=("$(echo "$AVAIL" | jq_ "d[0]['id'] if d else ''")"); fi
  [ -n "${TABLES[0]:-}" ] || { echo "No tables available to link."; exit 1; }
  for TID in "${TABLES[@]}"; do
    NAME="$(echo "$AVAIL" | python3 -c "import sys,json;tid='$TID';print(next((t.get('displayName',tid) for t in json.load(sys.stdin) if t['id']==tid),tid))")"
    # split composite ids (Airtable 'baseId,tableId', Webflow 'siteId,collectionId') into repeated --table-id
    ARGS=(); IFS=','; for part in $TID; do ARGS+=(--table-id "$part"); done; unset IFS
    echo "Linking $NAME ($TID)"
    "$B" linked --workspace "$WB" add --connection-id "$CONN" "${ARGS[@]}" --name "$NAME" --json >/dev/null
  done
else
  echo "Connection reused — not re-linking (avoids duplicate folders); re-pulling existing tables."
fi

echo "Pulling…"; "$B" linked --workspace "$WB" pull-all --json >/dev/null || true
sleep 6
RC="$(curl -s "$SCRATCH_URL/workbook/$WB" -H "Authorization: API-Token $TOKEN" | jq_ "d.get('recordCount','?')" 2>/dev/null || echo '?')"
echo ""
echo "✅ Workspace ready: $WB ($WS_NAME) — recordCount: $RC"
echo "   Drive the desktop app against it:"
echo "     QA_WORKBOOK_ID=$WB node .claude/skills/qa-desktop-app/qa-driver.mjs"
