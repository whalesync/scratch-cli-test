#!/bin/bash
# Scratch Scenario Tests
#
# Full end-to-end test: Airtable → Scratch → WordPress / Supabase
# Each phase builds on the previous. Run in order.
#
# Usage:
#   ./run.sh                  # run all phases (0-2)
#   ./run.sh phase1           # run a single phase
#   ./run.sh phase1 phase2    # run specific phases
#
# Prerequisites:
#   - .env file with credentials (see setup-airtable.py)
#   - scratch-ui and scratch-git-2 running locally
#   - scratch CLI built and on PATH
#   - jq installed

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Source .env — note: values with spaces must be quoted in .env
set -a
source "$SCRIPT_DIR/.env"
set +a

export SCRATCH_API_URL="${SCRATCH_API_URL:-http://localhost:8000}"
export NO_COLOR=1

# Add scratch CLI binary to PATH (built from scratch-engine)
SCRATCH_BIN="$REPO_ROOT/scratch-engine/target/debug"
if [[ -x "$SCRATCH_BIN/scratch" ]]; then
    export PATH="$SCRATCH_BIN:$PATH"
elif [[ -x "$REPO_ROOT/scratch-engine/target/release/scratch" ]]; then
    export PATH="$REPO_ROOT/scratch-engine/target/release:$PATH"
fi

if ! command -v scratch &>/dev/null; then
    echo "Error: scratch CLI not found on PATH"
    echo "  Build it: cd $REPO_ROOT/scratch-engine && cargo build --manifest-path crates/scratch-cli/Cargo.toml"
    exit 1
fi

# Create a temp workspace directory for the CLI
WORKSPACE_DIR=$(mktemp -d)
cd "$WORKSPACE_DIR"
echo "Workspace directory: $WORKSPACE_DIR"

PASSED=0
FAILED=0

run_phase() {
    local name="$1"
    local desc="$2"
    echo ""
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "  $name: $desc"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

assert_wp() {
    if "$SCRIPT_DIR/assert-wordpress.sh" "$1"; then
        PASSED=$((PASSED + 1))
    else
        FAILED=$((FAILED + 1))
    fi
}

# ── Phase 0: Setup (create workbook, connections, syncs via CLI) ─────────────

phase0() {
    run_phase "Phase 0" "Setup — create workspace, connections, tables, syncs"

    python3 "$SCRIPT_DIR/setup.py"
}

# ── Phase 1: First sync (clean destinations) ─────────────────────────────

phase1() {
    run_phase "Phase 1" "First sync — clean destinations"

    echo "Resetting WordPress..."
    "$SCRIPT_DIR/reset/wordpress.sh"

    echo ""
    echo "Running syncs..."
    scratch sync run --all

    echo ""
    echo "Pulling synced files to local workspace..."
    scratch pull

    echo ""
    echo "Validating workspace..."
    scratch validate

    echo ""
    echo "Reviewing changes..."
    scratch diff

    echo ""
    echo "Publishing to WordPress..."
    scratch publish

    echo ""
    echo "Asserting WordPress state..."
    assert_wp "$SCRIPT_DIR/expected/wordpress.json"
}

# ── Phase 2: Idempotency (re-run, no changes) ────────────────────────────

phase2() {
    run_phase "Phase 2" "Idempotency — re-run with no source changes"

    echo "Running pull → sync → pull → validate → diff → publish (again)..."
    scratch pull
    scratch sync run --all
    scratch pull

    echo ""
    echo "Validating workspace..."
    scratch validate || true

    echo ""
    echo "Reviewing changes (expecting none)..."
    scratch diff

    echo ""
    echo "Publishing..."
    scratch publish

    echo ""
    echo "Asserting WordPress unchanged..."
    assert_wp "$SCRIPT_DIR/expected/wordpress.json"
}

# ── Main ──────────────────────────────────────────────────────────────────

phases="${*:-phase0 phase1 phase2}"

# Always reset WordPress when tests finish (pass or fail)
trap '"$SCRIPT_DIR/reset/wordpress.sh" 2>/dev/null; rm -rf "$WORKSPACE_DIR"' EXIT

for phase in $phases; do
    case "$phase" in
        phase0) phase0 ;;
        phase1) phase1 ;;
        phase2) phase2 ;;
        *) echo "Unknown phase: $phase"; exit 1 ;;
    esac
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Results: $PASSED passed, $FAILED failed"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $FAILED -gt 0 ]]; then
    exit 1
fi
