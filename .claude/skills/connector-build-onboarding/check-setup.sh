#!/usr/bin/env bash
# connector-build onboarding — checks the bash-testable prerequisites and reports
# which browser option(s) are available. The MCP-based checks (Chrome extension,
# gmail-whalesync) are done by the skill itself, since they need the agent's tools.
#
#   bash .claude/skills/connector-build-onboarding/check-setup.sh
#
# Assumes the dev environment (repo, yarn install, Docker, DB+migrations, server,
# scratchmd build, node 22) is ALREADY set up — this only checks the connector-build
# extras (browser + secrets file).
set -uo pipefail
ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
H="$ROOT/.claude/skills/connector-build-prepare/lib/credential-helpers.sh"
ok(){   printf '  \033[32m✅ %s\033[0m\n' "$1"; }
warn(){ printf '  \033[33m⚠️  %s\033[0m\n' "$1"; }
bad(){  printf '  \033[31m❌ %s\033[0m\n' "$1"; }
bold(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

bold "1. Secrets file (connector-build/.env.connector-build)"
ENVF="$ROOT/connector-build/.env.connector-build"
if [ -f "$ENVF" ]; then
  ok "present — secrets will be read/written here"
else
  warn "missing — building a NEW connector doesn't need existing secrets, but the file must exist to write into."
  echo "      Fix (either): copy the shared note from 1Password \"connector-build secrets\","
  echo "      or create an empty one:  cp \"$ROOT/connector-build/.env.connector-build.sample\" \"$ENVF\""
fi

bold "2. gstack browser (option A — headless + headed)"
B="$(bash "$H" browse-bin 2>/dev/null || true)"
if [ -n "${B:-}" ] && [ -x "$B" ]; then
  ok "gstack binary found: $B"
  echo "      The skill will smoke-test 'connect' (headless) and 'connect --headed' live."
else
  bad "gstack binary not found."
  echo "      Install the gstack browser (the /browse skill's daemon). Then re-run this check."
fi

bold "3. Chrome extension (option B) + gmail-whalesync MCP — checked by the skill"
echo "      These are MCP-based; the onboarding skill verifies them with its tools:"
echo "      • Claude-for-Chrome extension: installed + connected via /connect-chrome"
echo "      • gmail-whalesync MCP: connected (run gmail-setup if absent — see SKILL.md)"

bold "Readiness rule"
echo "  READY when: gstack works  AND  Chrome+extension works  AND  gmail-whalesync is connected."
echo "  BOTH browsers are required — they are each other's fallback for unattended runs."
echo "  (Local voice model is optional.)"
