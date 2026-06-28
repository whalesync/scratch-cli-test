#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/cleanup_failed_release.sh
#
# Runs in the cleanup stage after the release pipeline. Consumes the same
# release.env dotenv as the other jobs. If the release identified by
# RELEASE_ID is still a draft AND carries no platform installer assets, we
# assume the pipeline failed before producing a build and delete it so the tag
# is freed for the next attempt. If the release has already been published
# (draft: false), or it is a draft that already holds installers from one or
# more platforms (an in-progress release awaiting a failed platform's retry),
# we leave it alone — deleting it would discard real artifacts.
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

GITHUB_REPO="whalesync/scratch-desktop"

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

# Guard against destroying real work. A draft that already holds platform
# installers is an in-progress release — some platform jobs uploaded their
# artifacts while another platform's job failed and is awaiting a retry — NOT an
# abandoned husk. Deleting it discards the installers those jobs already built
# and forces the release to be recreated for whichever platform happens to retry.
# That is exactly how v1.0.49 shipped macOS-only: the mac package job failed,
# this janitor deleted the draft that already held the Windows + Linux
# installers, and a day later only the mac chain was retried — recreating a
# mac-only release (the upload/finalize ensure_draft_release recreate-on-404 path
# from DEV-10257). So only delete a draft that carries no installer assets (the
# genuine "pipeline failed before producing anything" case this was built for).
# A non-empty draft is left for the retry to finish or a human to inspect/delete;
# bootstrap already counts drafts when picking the next version, so a lingering
# draft never collides with a future release.
# The GET /releases/:id response above includes the release's assets array.
INSTALLER_ASSET_NAMES_ON_DRAFT=$(jq -r '.assets[].name' < /tmp/cleanup_body \
  | grep -iE '\.(dmg|zip|exe|AppImage|deb)$' || true)
if [ -n "$INSTALLER_ASSET_NAMES_ON_DRAFT" ]; then
  echo "Draft release $NEW_VERSION already holds platform installers — refusing to delete it:"
  echo "$INSTALLER_ASSET_NAMES_ON_DRAFT" | sed 's/^/  /'
  echo "Leaving the draft intact so a retry can finish it (or a human can inspect/delete it)."
  exit 0
fi

echo "Release $NEW_VERSION is still a draft with no installer assets — pipeline did not produce a build. Deleting..."
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
