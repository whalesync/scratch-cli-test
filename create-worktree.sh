#!/bin/bash
#
# create-worktree.sh
#
# Creates a new git worktree with a new branch (based on master) and
# copies essential non-git files (e.g. .env) into it.
#
# Usage:
#   1. Run from the repo root:  ./create-worktree.sh ../my-worktree
#   2. Enter the worktree:      cd ../my-worktree
#   3. Install dependencies:    cd client && yarn install && cd ..
#                                cd server && yarn install && cd ..
#
# The new branch is named after the worktree directory (e.g. "../my-worktree"
# creates a branch called "my-worktree").
#

set -euo pipefail

usage() {
  echo "Usage: ./create-worktree.sh <path>"
  echo ""
  echo "Creates a new git worktree with a new branch based on master"
  echo "and copies .env files into it."
  echo ""
  echo "The branch is named after the directory (e.g. ../my-worktree -> my-worktree)."
  echo ""
  echo "Example:"
  echo "  ./create-worktree.sh ../my-worktree"
  echo "  cd ../my-worktree"
  echo "  cd client && yarn install && cd .."
  echo "  cd server && yarn install && cd .."
}

if [ $# -ne 1 ]; then
  usage
  exit 1
fi

WORKTREE_PATH="$1"
BRANCH_NAME=$(basename "$WORKTREE_PATH")

# Create the worktree with a new branch based on master
git worktree add -b "$BRANCH_NAME" "$WORKTREE_PATH" master

# Files to copy (relative to repo root)
ENV_FILES=(
  "client/.env"
  "client/.env.test"
  "server/.env"
  "server/.env.integration"
  "smoke-tests/.env.integration"
)

MAIN_WORKTREE=$(git worktree list --porcelain | head -1 | sed 's/^worktree //')

echo ""
echo "Copying .env files..."

copied=0
skipped=0

for file in "${ENV_FILES[@]}"; do
  src="$MAIN_WORKTREE/$file"
  dest="$WORKTREE_PATH/$file"

  if [ ! -f "$src" ]; then
    echo "  skip: $file (not found in main worktree)"
    ((skipped++))
    continue
  fi

  cp "$src" "$dest"
  echo "  copied: $file"
  ((copied++))
done

echo ""
echo "Done. Worktree created at $WORKTREE_PATH on branch $BRANCH_NAME with $copied .env file(s) copied."
echo ""
echo "Next steps:"
echo "  cd $WORKTREE_PATH"
echo "  cd client && yarn install && cd .."
echo "  cd server && yarn install && cd .."
