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

# Best-effort reaper for OTHER pipelines' abandoned drafts whose own cleanup job
# never ran (pipeline cancelled, or a job sat pending and the cleanup stage was
# never reached). Without this a failed hourly test pipeline leaves a 0-asset
# draft that lingers indefinitely — and because bootstrap's no-op marker used to
# count drafts, a single such orphan made the guard rebuild the same commit every
# hour (DEV-10749). Same hard safety rules as the single-release path below:
#   * DRAFTS only (never published releases),
#   * the SAME channel as this release (…-test only — prod drafts are rare and
#     human-monitored, so we never sweep them),
#   * NO installer assets (never discard real artifacts — the v1.0.49 lesson),
#   * older than STALE_DRAFT_MIN_AGE_SECONDS, so we can never race a build that is
#     still running (well beyond any full pipeline's worst-case runtime).
# Never fails the job.
STALE_DRAFT_MIN_AGE_SECONDS=21600 # 6h
sweep_stale_orphaned_test_drafts() {
  local releases_json stale sid stag http
  releases_json=$(curl -sS \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100" 2>/dev/null) || return 0
  stale=$(printf '%s' "$releases_json" | jq -r \
    --arg self "$RELEASE_ID" --arg minage "$STALE_DRAFT_MIN_AGE_SECONDS" '
      .[] | select(
        .draft == true
        and (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-test$"))
        and ((.id | tostring) != $self)
        and ([.assets[].name | select(test("\\.(dmg|zip|exe|AppImage|deb)$"; "i"))] | length == 0)
        and ((now - (.created_at | fromdateiso8601)) > ($minage | tonumber))
      ) | "\(.id)\t\(.tag_name)"' 2>/dev/null) || return 0
  if [ -z "$stale" ]; then
    echo "Sweep: no stale orphaned test drafts to reap."
    return 0
  fi
  while IFS=$'\t' read -r sid stag; do
    [ -z "$sid" ] && continue
    echo "Sweep: deleting stale orphaned draft $stag (id=$sid; >6h old, no installer assets)..."
    http=$(curl -sS -o /dev/null -w "%{http_code}" -X DELETE \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github.v3+json" \
      "https://api.github.com/repos/${GITHUB_REPO}/releases/${sid}" 2>/dev/null) || http="000"
    if [ "$http" = "204" ]; then
      echo "  ✓ deleted $stag"
    else
      echo "  WARN: DELETE $stag returned HTTP $http (leaving for manual cleanup)."
    fi
  done <<< "$stale"
  return 0
}

# Only the test channel accumulates orphans (hourly cadence); leave prod alone.
case "$NEW_VERSION" in
  *-test) sweep_stale_orphaned_test_drafts || true ;;
esac

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
