#!/usr/bin/env bash
# Run scratchmd pull to create a local CLI workspace.
# Usage: ./pull.sh [--output /path/to/output]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
OUTPUT="${1:-$REPO_ROOT/local/cli-v4}"

cargo run -- pull \
  --server "${SCRATCH_SERVER_URL:-http://localhost:3011}" \
  --scratchmd-url "${SCRATCHMD_URL:-http://localhost:3100}" \
  --workbook-id "${EXP_WORKBOOK_ID:-exp-wb-1}" \
  --output "$OUTPUT"
