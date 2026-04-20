#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/cleanup_failed_release.sh
#
# Runs in the cleanup stage after the release pipeline. Consumes the same
# release.env dotenv as the other jobs. If the release identified by
# RELEASE_ID is still a draft, we assume the pipeline failed to publish it
# and delete it so the tag is freed for the next attempt. If the release has
# already been published (draft: false), we leave it alone.
#
# This job must never fail the pipeline — it's a best-effort janitor.
#
# Required env (from bootstrap dotenv):
#   RELEASE_ID, NEW_VERSION
# Required secret:
#   GITHUB_TOKEN

if [ -z "$RELEASE_ID" ] || [ -z "$NEW_VERSION" ]; then
  echo "No RELEASE_ID / NEW_VERSION in env — bootstrap likely did not run. Nothing to clean up."
  exit 0
fi
if [ -z "$GITHUB_TOKEN" ]; then
  echo "WARN: GITHUB_TOKEN is not set; skipping cleanup."
  exit 0
fi
if ! command -v jq &>/dev/null; then
  echo "WARN: jq is not installed; skipping cleanup."
  exit 0
fi

GITHUB_REPO="whalesync/scratch-cli"

echo "Checking release $NEW_VERSION (id=$RELEASE_ID)..."

LOOKUP_HTTP=$(curl -sS -o /tmp/cleanup_body -w "%{http_code}" \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}")

if [ "$LOOKUP_HTTP" = "404" ]; then
  echo "Release $RELEASE_ID not found — nothing to clean up."
  exit 0
fi
if [ "$LOOKUP_HTTP" != "200" ]; then
  echo "WARN: Unexpected HTTP $LOOKUP_HTTP from GET /releases/${RELEASE_ID}. Response:"
  cat /tmp/cleanup_body
  exit 1
fi

IS_DRAFT=$(jq -r '.draft' < /tmp/cleanup_body)
if [ "$IS_DRAFT" != "true" ]; then
  echo "Release $NEW_VERSION is published (draft=$IS_DRAFT). Leaving it alone."
  exit 0
fi

echo "Release $NEW_VERSION is still a draft — pipeline did not publish it. Deleting..."
DELETE_HTTP=$(curl -sS -o /tmp/cleanup_body -w "%{http_code}" -X DELETE \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases/${RELEASE_ID}")

if [ "$DELETE_HTTP" = "204" ]; then
  echo "✓ Deleted draft release $NEW_VERSION (id=$RELEASE_ID)."
else
  echo "WARN: DELETE returned HTTP $DELETE_HTTP. Response:"
  cat /tmp/cleanup_body
  echo
  echo "You may need to delete the draft manually on GitHub."
fi
