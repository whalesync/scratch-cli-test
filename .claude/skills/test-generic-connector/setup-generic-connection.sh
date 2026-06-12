#!/usr/bin/env bash
# setup-generic-connection.sh — create a GENERIC_API connection programmatically.
#
# The scratchmd CLI cannot create generic connections (it drops `extras`), so this
# POSTs directly to the WEB connections endpoint using the CLI's API token.
#
# Usage:
#   SCRATCH_SERVER=http://localhost:3010 \
#   ./setup-generic-connection.sh <workbookId> <body.json>
#
#   <body.json> is the full request body, e.g.:
#   {
#     "service": "GENERIC_API",
#     "displayName": "Linear",
#     "userProvidedParams": { "apiKey": "<the target service's key>" },
#     "extras": {
#       "apiType": "rest",
#       "authHeader": { "style": "bearer" },
#       "endpoints": [
#         { "id": "<uuid>", "name": "Issues", "method": "GET", "url": "https://api.linear.app/..." }
#       ]
#     }
#   }
#
# Auth token resolution order:
#   1. $SCRATCH_API_TOKEN (if set)
#   2. ~/.scratchmd/credentials.yaml → environments[<host of SCRATCH_SERVER>].apiToken
#
# Reminders enforced server-side (this script does not check them):
#   - ENABLE_GENERIC_CONNECTOR must be on for the acting user (else 403).
#   - A live auth probe runs at create time — the apiKey must already be valid (else no row).
#   - SSRF guard: endpoint URLs must be public HTTPS resolving to public IPs.
set -euo pipefail

SERVER="${SCRATCH_SERVER:-http://localhost:3010}"
WORKBOOK_ID="${1:-}"
BODY_FILE="${2:-}"

if [[ -z "$WORKBOOK_ID" || -z "$BODY_FILE" ]]; then
  echo "usage: SCRATCH_SERVER=<url> $0 <workbookId> <body.json>" >&2
  exit 2
fi
if [[ ! -f "$BODY_FILE" ]]; then
  echo "error: body file not found: $BODY_FILE" >&2
  exit 2
fi

# --- resolve token ---
TOKEN="${SCRATCH_API_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  CRED="$HOME/.scratchmd/credentials.yaml"
  if [[ -f "$CRED" ]] && command -v python3 >/dev/null 2>&1; then
    TOKEN="$(SERVER="$SERVER" CRED="$CRED" python3 - <<'PY'
import os, sys
try:
    import yaml  # type: ignore
except Exception:
    sys.exit(0)  # PyYAML missing → fall through to error below
from urllib.parse import urlparse
host = urlparse(os.environ["SERVER"]).netloc
data = yaml.safe_load(open(os.environ["CRED"])) or {}
envs = data.get("environments", {}) or {}
# exact host match, else the sole environment if there is only one
entry = envs.get(host) or (next(iter(envs.values())) if len(envs) == 1 else None)
print((entry or {}).get("apiToken", ""))
PY
)"
  fi
fi
if [[ -z "$TOKEN" ]]; then
  echo "error: no API token. Set SCRATCH_API_TOKEN, or run 'scratchmd auth login' so" >&2
  echo "       ~/.scratchmd/credentials.yaml holds an environment for ${SERVER}." >&2
  exit 1
fi

# --- create the connection ---
URL="${SERVER%/}/workbooks/${WORKBOOK_ID}/connections"
echo "POST $URL" >&2
HTTP_CODE="$(curl -sS -o /tmp/generic-conn-resp.json -w '%{http_code}' \
  -X POST "$URL" \
  -H "Authorization: API-Token ${TOKEN}" \
  -H "Content-Type: application/json" \
  --data-binary "@${BODY_FILE}")"

echo "HTTP $HTTP_CODE" >&2
if command -v python3 >/dev/null 2>&1; then
  python3 -m json.tool /tmp/generic-conn-resp.json 2>/dev/null || cat /tmp/generic-conn-resp.json
else
  cat /tmp/generic-conn-resp.json
fi
echo
[[ "$HTTP_CODE" =~ ^2 ]] || { echo "create failed (HTTP $HTTP_CODE)" >&2; exit 1; }
