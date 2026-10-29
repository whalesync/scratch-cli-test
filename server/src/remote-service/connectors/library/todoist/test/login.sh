#!/usr/bin/env bash
# Automated login for the Todoist test account. Reads creds from the shared test-credentials
# store (secret `todoist`) via the credential helper — never echoes the password.
#   bash login.sh                                 # browser session `todoist` (opened headless if it isn't open)
#   PLAYWRIGHT_CLI_SESSION=<name> bash login.sh   # drive another playwright-cli session
#   bash login.sh logout
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
H="$ROOT/.claude/skills/connector-build-prepare/lib/credential-helpers.sh"
ACCOUNT=todoist
# Every playwright-cli call below, and the helper's, drives this session.
export PLAYWRIGHT_CLI_SESSION="${PLAYWRIGHT_CLI_SESSION:-$ACCOUNT}"
LOGIN_URL="https://app.todoist.com/auth/login"
APP_URL="https://app.todoist.com/app"

bash "$H" open-browser "$ACCOUNT" >/dev/null

if [ "${1:-}" = "logout" ]; then
  playwright-cli goto "$APP_URL/settings" >/dev/null || true
  playwright-cli eval "fetch('/api/v1/user/logout',{method:'POST'}).catch(()=>{})" >/dev/null || true
  playwright-cli goto "$LOGIN_URL" >/dev/null
  echo "logged out"; exit 0
fi

bash "$H" require "$ACCOUNT" TODOIST_LOGIN_EMAIL TODOIST_PASSWORD >/dev/null

playwright-cli goto "$LOGIN_URL" >/dev/null
sleep 3
bash "$H" enter-secret "$ACCOUNT" TODOIST_LOGIN_EMAIL 'input[type=email]'
# password supplied by the helper from the store — never printed here
bash "$H" enter-secret "$ACCOUNT" TODOIST_PASSWORD 'input[type=password]'
# submit via JS — a JS click also gets past any overlay covering the button
playwright-cli eval "document.querySelector('button[type=submit]')?.click()" >/dev/null
sleep 6

url="$(playwright-cli --raw eval "location.href" | tr -d '"')"
case "$url" in
  *"/auth/login"*)          echo "LOGIN FAILED — still on the login wall ($url)"; exit 1;;
  *"/account-verification"*) echo "CREDS OK but account needs email verification ($url)"; exit 2;;
  *"/app"*)                 echo "LOGIN OK — authenticated at $url"
                            bash "$H" save-browser-session "$ACCOUNT" >/dev/null && echo "session saved for '$ACCOUNT'";;
  *)                        echo "UNCERTAIN — landed at $url"; exit 3;;
esac
