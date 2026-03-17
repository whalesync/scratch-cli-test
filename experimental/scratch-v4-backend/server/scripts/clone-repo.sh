#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
set -a; source "$SCRIPT_DIR/.env"; set +a

REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
DEST_ROOT="$REPO_ROOT/local/repos-cloned-v4"

clone_conn() {
  local conn_id="$1"
  local src="$GIT_REPOS_DIR/$EXP_ORG_ID/$EXP_WORKBOOK_ID/$conn_id/repo.git"
  local dest="$DEST_ROOT/$conn_id"

  echo "Cloning $conn_id → $dest"
  rm -rf "$dest"
  git clone "$src" "$dest"
  cd "$dest" && git checkout master
  echo "  Files: $(ls "$dest" | tr '\n' ' ')"
}

# Clone workbook repo
WORKBOOK_SRC="$GIT_REPOS_DIR/$EXP_ORG_ID/$EXP_WORKBOOK_ID/workbook.git"
WORKBOOK_DEST="$DEST_ROOT/workbook"
echo "Cloning workbook → $WORKBOOK_DEST"
rm -rf "$WORKBOOK_DEST"
git clone "$WORKBOOK_SRC" "$WORKBOOK_DEST"
cd "$WORKBOOK_DEST" && git checkout master
echo "  Files: $(ls "$WORKBOOK_DEST" 2>/dev/null | tr '\n' ' ' || echo '(empty)')"

clone_conn "$EXP_CONN_ID"
clone_conn "$EXP_WEBFLOW_CONN_ID"

echo ""
echo "Done. Cloned to $DEST_ROOT"
