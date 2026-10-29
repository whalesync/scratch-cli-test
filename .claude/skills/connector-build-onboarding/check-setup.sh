#!/usr/bin/env bash
# connector-build onboarding — checks the bash-testable prerequisites and reports
# which browser option(s) are available. The MCP-based checks (Chrome extension,
# gmail-whalesync) are done by the skill itself, since they need the agent's tools.
#
#   bash .claude/skills/connector-build-onboarding/check-setup.sh
#
# Assumes the dev environment (repo, yarn install, Docker, DB+migrations, server,
# scratchmd build, node 22) is ALREADY set up — this only checks the connector-build
# extras (browser + access to the shared secrets store).
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
H="$ROOT/.claude/skills/connector-build-prepare/lib/credential-helpers.sh"
ok(){   printf '  \033[32m✅ %s\033[0m\n' "$1"; }
warn(){ printf '  \033[33m⚠️  %s\033[0m\n' "$1"; }
bad(){  printf '  \033[31m❌ %s\033[0m\n' "$1"; }
bold(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

bold "1. Secrets store (Secret Manager, GCP project whalesync-test-credentials)"
if ! command -v gcloud >/dev/null 2>&1; then
  bad "gcloud not installed — the credential helper reads and writes secrets through it."
elif accounts="$(bash "$H" list 2>/dev/null)"; then
  ok "readable as $(gcloud config get-value account 2>/dev/null) — $(printf '%s\n' "$accounts" | grep -c .) test account(s) stored"
else
  bad "can't list the store."
  echo "      Fix: sign gcloud in as your whalesync.com login or your read-only laptop service account"
  echo "      (check with 'gcloud auth list'), then re-run this check."
fi

bold "2. Playwright browser (option A — playwright-cli, headless + headed)"
if command -v playwright-cli >/dev/null 2>&1; then
  ok "playwright-cli $(playwright-cli --version 2>/dev/null) found: $(command -v playwright-cli)"
  echo "      The skill will smoke-test a headless and a headed session live."
else
  bad "playwright-cli not found."
  echo "      Install it: yarn global add @playwright/cli   (it drives your installed Google Chrome)."
  echo "      Then re-run this check."
fi

bold "3. Chrome extension (option B) + gmail-whalesync MCP — checked by the skill"
echo "      These are MCP-based; the onboarding skill verifies them with its tools:"
echo "      • Claude-for-Chrome extension: installed + connected via /chrome"
echo "      • gmail-whalesync MCP: connected (run gmail-setup if absent — see SKILL.md)"

bold "Readiness rule"
echo "  READY when: playwright-cli works  AND  Chrome+extension works  AND  gmail-whalesync is connected."
echo "  BOTH browsers are required — they are each other's fallback for unattended runs."
echo "  (Local voice model is optional.)"
