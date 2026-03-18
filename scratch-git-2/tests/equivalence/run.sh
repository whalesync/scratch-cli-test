#!/usr/bin/env bash
# Equivalence test: Go CLI (scratchmd) vs Rust CLI (scratchmd2)
#
# Usage:
#   WORKBOOK_ID=wb_xxx \
#   CONNECTION_1_ID=conn_xxx \
#   CONNECTION_2_ID=conn_yyy \
#   ./run.sh
#
# Optional overrides:
#   GO_CLI=scratchmd                                    Path to Go CLI binary
#   RUST_CLI=./target/debug/scratchmd2                  Path to Rust CLI binary
#   SCRATCH_URL=http://localhost:3010                    Server URL

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd)"

GO="${GO_CLI:-scratchmd}"
RUST="${RUST_CLI:-$SCRIPT_DIR/../../target/debug/scratchmd2}"
URL="${SCRATCH_URL:-http://localhost:3010}"
WB="${WORKBOOK_ID:?WORKBOOK_ID env var required}"
CONN1="${CONNECTION_1_ID:?CONNECTION_1_ID env var required}"
CONN2="${CONNECTION_2_ID:?CONNECTION_2_ID env var required}"

PASS=0
FAIL=0
SKIP=0

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Remove fields that legitimately differ between calls (timestamps, etc.)
normalize() {
  jq -S 'walk(
    if type == "object"
    then del(.createdAt, .updatedAt, .lastSyncTime, .initializedAt, .expiresAt)
    else .
    end
  )'
}

# Sort an array of objects by .id for stable comparison
sort_array_by_id() {
  jq -S 'if type == "array" then sort_by(.id) else . end'
}

compare() {
  local name="$1"
  local go_json="$2"
  local rust_json="$3"

  local go_norm rust_norm
  go_norm=$(echo "$go_json"   | normalize | sort_array_by_id)
  rust_norm=$(echo "$rust_json" | normalize | sort_array_by_id)

  if diff <(echo "$go_norm") <(echo "$rust_norm") >/dev/null 2>&1; then
    echo "PASS  $name"
    ((PASS++)) || true
  else
    echo "FAIL  $name"
    diff <(echo "$go_norm") <(echo "$rust_norm") | head -40 || true
    ((FAIL++)) || true
  fi
}

# Run a command on both CLIs and compare JSON output.
# go_args and rust_args should NOT include --json or --scratch-url; those are appended.
run_test() {
  local name="$1"
  local go_args="$2"
  local rust_args="$3"

  local go_out rust_out exit_go exit_rust

  set +e
  go_out=$($GO   --scratch-url "$URL" $go_args   --json 2>&1); exit_go=$?
  rust_out=$($RUST --scratch-url "$URL" $rust_args --json 2>&1); exit_rust=$?
  set -e

  if [[ $exit_go -ne 0 ]]; then
    echo "FAIL  $name  (go cli error: $go_out)"
    ((FAIL++)) || true
    return
  fi
  if [[ $exit_rust -ne 0 ]]; then
    echo "FAIL  $name  (rust cli error: $rust_out)"
    ((FAIL++)) || true
    return
  fi

  compare "$name" "$go_out" "$rust_out"
}

skip_test() {
  local name="$1"
  local reason="${2:-not yet implemented in rust}"
  echo "SKIP  $name  ($reason)"
  ((SKIP++)) || true
}

# ---------------------------------------------------------------------------
# Tests: auth  (no --json in Go CLI for auth status — compare plain text)
# ---------------------------------------------------------------------------
echo ""
echo "=== auth ==="

skip_test "auth status" "go CLI has no --json for auth status"

# ---------------------------------------------------------------------------
# Tests: workbooks
# Note: Go CLI uses 'workbooks', Rust CLI uses 'workspaces'
# ---------------------------------------------------------------------------
echo ""
echo "=== workbooks ==="

run_test "workbooks list" \
  "workbooks list" \
  "workspaces list"

run_test "workbooks show" \
  "workbooks show $WB" \
  "workspaces show $WB"

# ---------------------------------------------------------------------------
# Tests: connections
# Note: Go CLI uses --workbook, Rust CLI uses --workspace
# ---------------------------------------------------------------------------
echo ""
echo "=== connections ==="

run_test "connections list" \
  "connections list --workbook $WB" \
  "connections --workspace $WB list"

run_test "connections show (conn1)" \
  "connections show $CONN1 --workbook $WB" \
  "connections --workspace $WB show $CONN1"

run_test "connections show (conn2)" \
  "connections show $CONN2 --workbook $WB" \
  "connections --workspace $WB show $CONN2"

# ---------------------------------------------------------------------------
# Tests: linked  (skip until implemented in Rust)
# ---------------------------------------------------------------------------
echo ""
echo "=== linked ==="

skip_test "linked list"
skip_test "linked available (conn1)"
skip_test "linked available (conn2)"

# ---------------------------------------------------------------------------
# Tests: syncs  (skip until implemented in Rust)
# ---------------------------------------------------------------------------
echo ""
echo "=== syncs ==="

skip_test "syncs list"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"

[[ $FAIL -eq 0 ]]
