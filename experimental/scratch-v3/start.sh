#!/usr/bin/env bash
# Start all scratch-v3 servers. Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "$0")"
V3_ROOT="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"

cleanup() {
  echo ""
  echo "Stopping servers..."
  kill 0 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

echo "═══════════════════════════════════════════════════"
echo "  Starting scratch-v3 servers"
echo "═══════════════════════════════════════════════════"

# ── scratch-git-2 (port 3100 API + 3101 git backend) ─────────
echo ""
echo "Starting scratch-git-2 on :3100 / :3101..."
cd "$REPO_ROOT/scratch-git-2"
GIT_REPOS_DIR="$REPO_ROOT/scratch-git-2/local/scratch-git-repos" \
  cargo run --quiet 2>&1 | sed 's/^/  [git] /' &

# ── scratch-ui (port 8000) ───────────────────────────────────
echo "Starting scratch-ui on :8000..."
cd "$V3_ROOT/scratch-ui"
source .venv/bin/activate
uvicorn app.main:app --port 8000 --reload 2>&1 | sed 's/^/  [ui]  /' &

echo ""
echo "Servers starting..."
echo "  scratch-git-2  →  http://localhost:3100"
echo "  scratch-ui     →  http://localhost:8000"
echo ""
echo "Press Ctrl-C to stop all servers."
echo "═══════════════════════════════════════════════════"

wait
