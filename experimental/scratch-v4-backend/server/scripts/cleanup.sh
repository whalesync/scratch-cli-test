#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$SCRIPT_DIR/.env"; set +a

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

echo "=== Cleanup ==="
echo ""

# 1. Bare repos (repos-v4)
REPOS_DIR="$REPO_ROOT/local/repos-v4/$EXP_ORG_ID/$EXP_WORKBOOK_ID"
if [ -d "$REPOS_DIR" ]; then
  echo "Deleting bare repos: $REPOS_DIR"
  rm -rf "$REPOS_DIR"
else
  echo "  (repos-v4 already clean)"
fi

# 2. Cloned repos (repos-cloned-v4)
CLONED_DIR="$REPO_ROOT/local/repos-cloned-v4"
for conn_id in "$EXP_CONN_ID" "$EXP_WEBFLOW_CONN_ID"; do
  dest="$CLONED_DIR/$conn_id"
  if [ -d "$dest" ]; then
    echo "Deleting clone: $dest"
    rm -rf "$dest"
  fi
done

# 3. CLI workspace (cli-v4)
CLI_DIR="$REPO_ROOT/local/cli-v4"
if [ -d "$CLI_DIR" ] && [ -n "$(ls -A "$CLI_DIR" 2>/dev/null)" ]; then
  echo "Deleting CLI workspace: $CLI_DIR"
  rm -rf "${CLI_DIR:?}"/*
fi

echo ""
echo "✓ Done. Run 'yarn setup' to reinitialize."
