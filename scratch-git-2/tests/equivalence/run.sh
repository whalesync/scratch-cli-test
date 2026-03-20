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
# Also normalise null vs [] for the messages field (Go uses null, Rust uses []).
normalize() {
  jq -S '
    walk(
      if type == "object"
      then
        del(.createdAt, .updatedAt, .lastSyncTime, .initializedAt, .expiresAt)
        | del(.metadata, .disabled, .disabledCreates)
        | del(.displayOrder, .syncStateLastChanged)
        | if has("messages") and .messages == null then .messages = [] else . end
      else .
      end
    )
  '
}

# Sort an array of objects by .id for stable comparison
sort_array_by_id() {
  jq -S 'if type == "array" then sort_by(.id) else . end'
}

compare() {
  local name="$1"
  local go_out="$2"
  local rust_out="$3"

  local go_norm rust_norm
  go_norm=$(echo "$go_out"   | normalize | sort_array_by_id)
  rust_norm=$(echo "$rust_out" | normalize | sort_array_by_id)

  if diff <(echo "$go_norm") <(echo "$rust_norm") >/dev/null 2>&1; then
    echo "PASS  $name"
    ((PASS++)) || true
  else
    echo "FAIL  $name"
    diff <(echo "$go_norm") <(echo "$rust_norm") | head -40 || true
    ((FAIL++)) || true
  fi
}

compare_text() {
  local name="$1"
  local go_out="$2"
  local rust_out="$3"

  if diff <(echo "$go_out") <(echo "$rust_out") >/dev/null 2>&1; then
    echo "PASS  $name"
    ((PASS++)) || true
  else
    echo "FAIL  $name"
    diff <(echo "$go_out") <(echo "$rust_out") | head -40 || true
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
# Temp dirs for init/files tests — cleaned up on exit
# ---------------------------------------------------------------------------
GO_TMP=$(mktemp -d)
RUST_TMP=$(mktemp -d)
trap 'rm -rf "$GO_TMP" "$RUST_TMP"' EXIT

# ---------------------------------------------------------------------------
# Tests: auth  (no --json in Go CLI for auth status — skip)
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
# Tests: workbooks init
# Clones into separate temp dirs, then compares JSON output and file trees.
# ---------------------------------------------------------------------------
echo ""
echo "=== workbooks init ==="

set +e
go_init_out=$($GO   --scratch-url "$URL" workbooks init "$WB" --output "$GO_TMP"   --force --json 2>&1); exit_go=$?
rust_init_out=$($RUST --scratch-url "$URL" workspaces init "$WB" --output "$RUST_TMP" --force --json 2>&1); exit_rust=$?
set -e

if [[ $exit_go -ne 0 ]]; then
  echo "FAIL  workbooks init (go cli error: $go_init_out)"
  ((FAIL++)) || true
elif [[ $exit_rust -ne 0 ]]; then
  echo "FAIL  workbooks init (rust cli error: $rust_init_out)"
  ((FAIL++)) || true
else
  # Compare JSON output, excluding the `directory` field (always differs)
  go_init_norm=$(echo "$go_init_out"   | jq -S 'del(.directory)')
  rust_init_norm=$(echo "$rust_init_out" | jq -S 'del(.directory)')
  compare_text "workbooks init json" "$go_init_norm" "$rust_init_norm"

  # Derive workbook directory from JSON output
  WB_NAME=$(echo "$go_init_out" | jq -r '.workbookName')
  GO_WB_DIR="$GO_TMP/$WB_NAME"
  RUST_WB_DIR="$RUST_TMP/$WB_NAME"

  # Compare file trees (paths relative to workbook dir, excluding .git internals and .scratch/)
  go_tree=$(find "$GO_WB_DIR"   ! -path '*/.git/*' ! -path '*/.git' ! -path '*/.scratch*' \
            | sed "s|^$GO_WB_DIR/\{0,1\}||" | grep -v '^$' | grep -v '^\.gitignore$' | sort)
  rust_tree=$(find "$RUST_WB_DIR" ! -path '*/.git/*' ! -path '*/.git' ! -path '*/.scratch*' \
              | sed "s|^$RUST_WB_DIR/\{0,1\}||" | grep -v '^$' | grep -v '^\.gitignore$' | sort)
  compare_text "workbooks init file tree" "$go_tree" "$rust_tree"
fi

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
# Tests: files  (requires successful init above)
# ---------------------------------------------------------------------------
echo ""
echo "=== files ==="

if [[ -z "${WB_NAME:-}" ]]; then
  skip_test "files download (up_to_date)"    "workbooks init failed"
  skip_test "files upload go→rust round-trip" "workbooks init failed"
  skip_test "files upload rust→go round-trip" "workbooks init failed"
else
  # Find first connector dir (V2) or use workbook dir directly (V1)
  GO_CONN_DIR=$(find "$GO_WB_DIR" -maxdepth 1 -type d ! -path "$GO_WB_DIR" | head -1)
  RUST_CONN_DIR="$RUST_WB_DIR/$(basename "$GO_CONN_DIR")"

  # Use workbook dir itself if no connector subdir (V1)
  [[ -z "$GO_CONN_DIR" ]] && GO_CONN_DIR="$GO_WB_DIR"
  [[ -z "$RUST_CONN_DIR" || ! -d "$RUST_CONN_DIR" ]] && RUST_CONN_DIR="$RUST_WB_DIR"

  # files download — both should be up_to_date right after clone
  set +e
  go_dl=$(cd "$GO_CONN_DIR"   && $GO   --scratch-url "$URL" files download --json 2>&1); exit_go=$?
  rust_dl=$(cd "$RUST_CONN_DIR" && $RUST --scratch-url "$URL" files download --json 2>&1); exit_rust=$?
  set -e

  if [[ $exit_go -ne 0 ]]; then
    echo "FAIL  files download (go error: $go_dl)"
    ((FAIL++)) || true
  elif [[ $exit_rust -ne 0 ]]; then
    echo "FAIL  files download (rust error: $rust_dl)"
    ((FAIL++)) || true
  else
    compare "files download (up_to_date)" "$go_dl" "$rust_dl"
  fi

  # Round-trip 1: write with Go CLI, read with Rust CLI
  TEST_FILE_1="equiv-test-go-$(date +%s).md"
  echo "# Equivalence test (go→rust)" > "$GO_CONN_DIR/$TEST_FILE_1"

  set +e
  go_ul1=$(cd "$GO_CONN_DIR" && $GO --scratch-url "$URL" files upload --json 2>&1); exit_go=$?
  set -e

  if [[ $exit_go -ne 0 ]]; then
    echo "FAIL  files upload go→rust (upload error: $go_ul1)"
    ((FAIL++)) || true
    rm -f "$GO_CONN_DIR/$TEST_FILE_1"
  else
    set +e
    rust_dl1=$(cd "$RUST_CONN_DIR" && $RUST --scratch-url "$URL" files download --json 2>&1); exit_rust=$?
    set -e

    if [[ $exit_rust -ne 0 ]]; then
      echo "FAIL  files upload go→rust (download error: $rust_dl1)"
      ((FAIL++)) || true
    elif [[ -f "$RUST_CONN_DIR/$TEST_FILE_1" ]]; then
      echo "PASS  files upload go→rust round-trip"
      ((PASS++)) || true
    else
      echo "FAIL  files upload go→rust round-trip (file not found in rust clone after download)"
      ((FAIL++)) || true
    fi

    # Clean up: delete the test file and push deletion via Go CLI
    rm -f "$GO_CONN_DIR/$TEST_FILE_1"
    (cd "$GO_CONN_DIR" && $GO --scratch-url "$URL" files upload --json >/dev/null 2>&1) || true
  fi

  # Round-trip 2: write with Rust CLI, read with Go CLI
  TEST_FILE_2="equiv-test-rust-$(date +%s).md"
  echo "# Equivalence test (rust→go)" > "$RUST_CONN_DIR/$TEST_FILE_2"

  set +e
  rust_ul2=$(cd "$RUST_CONN_DIR" && $RUST --scratch-url "$URL" files upload --json 2>&1); exit_rust=$?
  set -e

  if [[ $exit_rust -ne 0 ]]; then
    echo "FAIL  files upload rust→go (upload error: $rust_ul2)"
    ((FAIL++)) || true
    rm -f "$RUST_CONN_DIR/$TEST_FILE_2"
  else
    set +e
    go_dl2=$(cd "$GO_CONN_DIR" && $GO --scratch-url "$URL" files download --json 2>&1); exit_go=$?
    set -e

    if [[ $exit_go -ne 0 ]]; then
      echo "FAIL  files upload rust→go (download error: $go_dl2)"
      ((FAIL++)) || true
    elif [[ -f "$GO_CONN_DIR/$TEST_FILE_2" ]]; then
      echo "PASS  files upload rust→go round-trip"
      ((PASS++)) || true
    else
      echo "FAIL  files upload rust→go round-trip (file not found in go clone after download)"
      ((FAIL++)) || true
    fi

    # Clean up: delete the test file and push deletion via Rust CLI
    rm -f "$RUST_CONN_DIR/$TEST_FILE_2"
    (cd "$RUST_CONN_DIR" && $RUST --scratch-url "$URL" files upload --json >/dev/null 2>&1) || true
  fi
fi

# ---------------------------------------------------------------------------
# Tests: linked
# Note: Go CLI uses --workbook, Rust CLI uses --workspace on the subcommand group
# ---------------------------------------------------------------------------
echo ""
echo "=== linked ==="

run_test "linked list" \
  "linked list --workspace $WB" \
  "linked --workspace $WB list"

run_test "linked available (conn1)" \
  "linked available $CONN1 --workspace $WB" \
  "linked --workspace $WB available $CONN1"

run_test "linked available (conn2)" \
  "linked available $CONN2 --workspace $WB" \
  "linked --workspace $WB available $CONN2"

# linked show requires a linked table ID
if [[ -n "${LINKED_TABLE_ID:-}" ]]; then
  run_test "linked show" \
    "linked show $LINKED_TABLE_ID --workspace $WB" \
    "linked --workspace $WB show $LINKED_TABLE_ID"
else
  skip_test "linked show" "LINKED_TABLE_ID not set"
fi

# ---------------------------------------------------------------------------
# Tests: syncs
# ---------------------------------------------------------------------------
echo ""
echo "=== syncs ==="

run_test "syncs list" \
  "syncs list --workspace $WB" \
  "syncs --workspace $WB list"

# syncs show requires a sync ID
if [[ -n "${SYNC_ID:-}" ]]; then
  run_test "syncs show" \
    "syncs show $SYNC_ID --workspace $WB" \
    "syncs --workspace $WB show $SYNC_ID"
else
  skip_test "syncs show" "SYNC_ID not set"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "Results: $PASS passed, $FAIL failed, $SKIP skipped"

[[ $FAIL -eq 0 ]]
