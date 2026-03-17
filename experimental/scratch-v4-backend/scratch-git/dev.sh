#!/usr/bin/env bash
# Run the scratchmd git server in dev mode.
# Repos are stored in /tmp/scratch-repos (matches server/.env GIT_REPOS_DIR).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
REPOS_DIR="${SCRATCHMD_REPOS_DIR:-$REPO_ROOT/local/repos-v4}"
PORT="${SCRATCHMD_PORT:-3100}"

cargo run -- serve --port "$PORT" --repos-dir "$REPOS_DIR"
