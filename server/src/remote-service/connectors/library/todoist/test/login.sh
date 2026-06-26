#!/usr/bin/env bash
# Automated login for the Todoist test account. Reads creds from .env.connector-build
# via the credential helper — never echoes the password.
#   bash login.sh                              # headless default daemon
#   CB_BROWSE_FLAGS=--headed bash login.sh     # drive the visible (headed) daemon
#   bash login.sh logout
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
H="$ROOT/.claude/skills/connector-build-prepare/lib/credential-helpers.sh"
B="$(bash "$H" browse-bin)"
BF="${CB_BROWSE_FLAGS:-}"
LOGIN_URL="https://app.todoist.com/auth/login"
APP_URL="https://app.todoist.com/app"

if [ "${1:-}" = "logout" ]; then
  "$B" goto "$APP_URL/settings" $BF >/dev/null || true
  "$B" js "fetch('/api/v1/user/logout',{method:'POST'}).catch(()=>{}); 'bye'" $BF >/dev/null || true
  "$B" goto "$LOGIN_URL" $BF >/dev/null
  echo "logged out"; exit 0
fi

bash "$H" require CB_TODOIST_LOGIN_EMAIL CB_TODOIST_PASSWORD >/dev/null
email="$(grep -E '^CB_TODOIST_LOGIN_EMAIL=' "$ROOT/connector-build/.env.connector-build" | sed -E "s/^[^=]+='?([^']*)'?\$/\1/")"

"$B" goto "$LOGIN_URL" $BF >/dev/null
sleep 3
"$B" fill 'input[type=email]' "$email" $BF >/dev/null
# password supplied by the helper from the env file — never printed here
bash "$H" enter-secret CB_TODOIST_PASSWORD 'input[type=password]'
# submit via JS — $B click can hang and reset the page to about:blank
"$B" js "var b=document.querySelector('button[type=submit]'); b&&b.click()" $BF >/dev/null
sleep 6

url="$("$B" url $BF | tail -1)"
case "$url" in
  *"/auth/login"*)          echo "LOGIN FAILED — still on the login wall ($url)"; exit 1;;
  *"/account-verification"*) echo "CREDS OK but account needs email verification ($url)"; exit 2;;
  *"/app"*)                 echo "LOGIN OK — authenticated at $url"
                            "$B" state save todoist $BF >/dev/null && echo "session saved as 'todoist'";;
  *)                        echo "UNCERTAIN — landed at $url"; exit 3;;
esac
