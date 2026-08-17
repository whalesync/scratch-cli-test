#!/bin/bash
set -e
# Ensure we are in the scratch-desktop directory regardless of where the script is called from
cd "$(dirname "$0")/.."

# Usage: ./scripts/bootstrap_release.sh <prod|test> <patch|minor|major>
#
# Computes the next desktop-release version, creates a DRAFT GitHub release on
# whalesync/scratch-desktop, updates scratch-desktop/package.json with the new
# semver, and writes scratch-desktop/release.env. The .env is consumed by
# downstream GitLab jobs via `artifacts.reports.dotenv`.

VARIANT=${1:-}
RELEASE_TYPE=${2:-}

if [[ "$VARIANT" != "prod" && "$VARIANT" != "test" ]]; then
  echo "Usage: $0 <prod|test> <patch|minor|major>"
  exit 1
fi
if [[ "$RELEASE_TYPE" != "patch" && "$RELEASE_TYPE" != "minor" && "$RELEASE_TYPE" != "major" ]]; then
  echo "Usage: $0 <prod|test> <patch|minor|major>"
  exit 1
fi

if ! command -v jq &>/dev/null; then
  echo "ERROR: jq is required but not installed."
  exit 1
fi

GITHUB_REPO="whalesync/scratch-desktop"

# Tags on the dedicated desktop repo are bare semver (prod) or semver-test (test).
# TAG_PATTERN is a regex passed to jq's test() so we can require an exact shape;
# `endswith` is too loose now that prod has no suffix at all.
#
# VERSION_SELECT_PATTERN is what we scan to pick the version to bump FROM. For
# prod it's just the prod tags. For test it is deliberately BROADER than
# TAG_PATTERN: it also matches the prod bare-semver tags, so the test version is
# floored at the prod line and can never regress below the latest prod release
# (a test build is "prod plus in-flight changes"). This also self-heals a
# missing/reset test line — the DEV-10749 failure, where the test channel was
# never seeded on the new repo, so the first bootstrap fell back to v0.0.0-test
# and shipped a v0.0.1-test sitting far below prod's v1.0.62.
if [ "$VARIANT" = "prod" ]; then
  TAG_SUFFIX=""
  TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'
  VERSION_SELECT_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'
  IS_PRERELEASE=false
  FALLBACK_TAG="v0.1.0"
  RELEASE_BODY=""
else
  TAG_SUFFIX="-test"
  TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+-test$'
  VERSION_SELECT_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+(-test)?$'
  IS_PRERELEASE=true
  FALLBACK_TAG="v0.0.0-test"
  # Stamp the monorepo commit into the body so the next hourly run can tell
  # whether anything changed since this release (see the no-op guard below).
  RELEASE_BODY="Test release pointing at test-api.scratch.md. Not for end users.
Source-Commit: ${CI_COMMIT_SHA:-unknown}"
fi
RELEASE_NAME_PREFIX="Scratch Desktop"

echo "Bootstrapping desktop ${VARIANT} release (${RELEASE_TYPE})..."

# Configure git (harmless if already set)
git config --global user.email "ci@whalesync.com"
git config --global user.name "GitLab CI"

curl_releases_page() {
  local page="${1:?page number required}"
  curl -sS --fail-with-body \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100&page=${page}"
}

# 1. Find the highest existing version to bump FROM on GitHub, considering both
#    published releases AND drafts. `GET /releases` returns every release visible
#    to the token — drafts don't have git refs yet, but their reserved tag_name
#    still has to be avoided, or concurrent pipelines will both pick the same
#    version. Fetch the first 3 API pages (300 releases) so the max is less
#    likely to be missed than with a single page (same pattern as
#    preview_desktop_release_version.sh).
#
#    We strip a trailing `-test` before version-sorting so the prod line and the
#    test line compare on the same bare-semver axis (VERSION_SELECT_PATTERN lets
#    the test variant see both). The result is the highest base semver across the
#    lines the variant cares about.
# Fetch the first 3 pages of releases ONCE. `curl_releases_page` uses
# `--fail-with-body`, so a non-2xx response makes the command substitution return
# non-zero; we check that explicitly and ABORT rather than let an empty/error
# result silently flow into the FALLBACK_TAG path below. A release job that cannot
# read the existing releases must never guess a version — that is exactly how a
# prod bootstrap once fell back to v0.1.0, cut v0.1.1, and shadowed the real
# "latest" (v1.0.104), wedging every client's auto-update (DEV-10749 class).
#
# We intentionally do NOT `set -o pipefail`: the `sort -V | head -n1` pipeline
# below relies on `head` closing the pipe early, which would SIGPIPE `sort` and
# abort the script under pipefail+`set -e`. Instead we validate each page here.
ALL_RELEASES_JSON=""
for page in 1 2 3; do
  if ! PAGE_JSON=$(curl_releases_page "$page"); then
    echo "ERROR: failed to fetch releases page $page from GitHub (${GITHUB_REPO})." >&2
    echo "       Refusing to compute a release version from an incomplete list." >&2
    exit 1
  fi
  if ! printf '%s' "$PAGE_JSON" | jq -e 'type == "array"' >/dev/null 2>&1; then
    echo "ERROR: GitHub releases page $page was not a JSON array (auth/rate-limit/API error?). Response:" >&2
    printf '%s\n' "$PAGE_JSON" >&2
    exit 1
  fi
  ALL_RELEASES_JSON+="${PAGE_JSON}"$'\n'
done

# Total releases of ANY tag shape. Distinguishes a genuinely empty repo (a real
# first release, where FALLBACK_TAG is correct) from "the fetch worked but no tag
# matched our variant" — on a populated repo the latter must NOT fall back, or we
# would again ship a version far below the live line.
TOTAL_RELEASE_COUNT=$(printf '%s' "$ALL_RELEASES_JSON" | jq -s 'add | length')

HIGHEST_EXISTING_BASE_SEMVER=$(printf '%s' "$ALL_RELEASES_JSON" \
  | jq -s 'add | .[] | select(.tag_name | test($pat)) | .tag_name' --arg pat "$VERSION_SELECT_PATTERN" -r \
  | sed 's/-test$//' \
  | sort -V -r \
  | head -n1)

if [ -z "$HIGHEST_EXISTING_BASE_SEMVER" ]; then
  if [ "${TOTAL_RELEASE_COUNT:-0}" -gt 0 ]; then
    echo "ERROR: ${TOTAL_RELEASE_COUNT} releases exist on ${GITHUB_REPO} but none match ${VERSION_SELECT_PATTERN}." >&2
    echo "       Refusing to fall back to ${FALLBACK_TAG} on a non-empty repo (would ship below 'latest')." >&2
    exit 1
  fi
  echo "No existing releases found — using fallback ${FALLBACK_TAG} (genuine first release)."
  HIGHEST_EXISTING_BASE_SEMVER=$(echo "$FALLBACK_TAG" | sed 's/-test$//')
fi
echo "Highest existing base semver (drafts included): $HIGHEST_EXISTING_BASE_SEMVER"

VERSION=$(echo "$HIGHEST_EXISTING_BASE_SEMVER" | grep -o '[0-9]\+\.[0-9]\+\.[0-9]\+')
IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"

# 2. Bump version
case "$RELEASE_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac

SEMVER="$MAJOR.$MINOR.$PATCH"
NEW_VERSION="v${SEMVER}${TAG_SUFFIX}"
echo "Target version: $NEW_VERSION"

# Safety floor (defense in depth): the computed version MUST be strictly greater
# than the highest existing release we actually observed. Even if the bump or
# fallback logic regresses, this refuses to publish a version at/below "latest" —
# the exact failure that let v0.1.1 shadow v1.0.104. Both sides are bare semver
# (any `-test` suffix was stripped above), so `sort -V` orders them correctly.
GREATEST_SEMVER=$(printf '%s\n%s\n' "$SEMVER" "$HIGHEST_EXISTING_BASE_SEMVER" | sort -V | tail -n1)
if [ "$SEMVER" = "$HIGHEST_EXISTING_BASE_SEMVER" ] || [ "$SEMVER" != "$GREATEST_SEMVER" ]; then
  echo "ERROR: computed version $SEMVER is not greater than the highest existing release $HIGHEST_EXISTING_BASE_SEMVER." >&2
  echo "       Refusing to publish a release that would sit at or below 'latest'." >&2
  exit 1
fi

# 2b. Hourly-schedule no-op guard (test variant only). Bootstrap is the gate for
#     the whole desktop chain, so skipping here skips every downstream job. We
#     compare monorepo HEAD against the Source-Commit stamped on the last test
#     release; if nothing under the desktop app, the CLI it bundles, or
#     shared-types changed, write a RELEASE_SKIP sentinel into release.env and
#     exit 0 — BEFORE creating any draft, so a no-op leaves nothing to clean up.
#     Downstream jobs read RELEASE_SKIP from the dotenv and early-exit. Fails open
#     (builds) if the marker is missing/unreachable. FORCE_RELEASE=1 bypasses.
if [[ "$VARIANT" == "test" && "${CI_PIPELINE_SOURCE:-}" == "schedule" && "${FORCE_RELEASE:-}" != "1" ]]; then
  # Marker = the Source-Commit of the highest-semver PUBLISHED test release.
  # Two deliberate choices, both learned from live misfires (DEV-10749):
  #   * PUBLISHED only (draft == false): a leftover draft was never actually
  #     shipped, so it must not define "the last release we cut". Counting drafts
  #     let an orphaned draft's older Source-Commit make the guard think there
  #     were changes and rebuild the SAME commit every hour, forever.
  #   * ordered by SEMVER, not created_at: GitHub reports an unreliable created_at
  #     for these releases — every published test release tags the same
  #     placeholder commit, so they all surface the repo's 2026-05-08 migration
  #     timestamp, while drafts get real (recent) times. sort_by(.created_at)
  #     therefore always picked the lingering draft over the real latest release.
  #     Sorting on the numeric [major,minor,patch] of the tag matches how the
  #     version to bump is chosen above.
  LAST_RELEASE_SHA=$(
    {
      for page in 1 2 3; do
        curl_releases_page "$page"
        printf '\n'
      done
    } | jq -s 'add
               | map(select(.draft == false and (.tag_name | test("^v[0-9]+\\.[0-9]+\\.[0-9]+-test$"))))
               | sort_by(.tag_name | ltrimstr("v") | rtrimstr("-test") | split(".") | map(tonumber))
               | last | .body // ""' -r \
    | sed -n 's/^Source-Commit:[[:space:]]*//p' | tr -d '\r' | head -n1)
  if [ -n "$LAST_RELEASE_SHA" ] && [ "$LAST_RELEASE_SHA" != "unknown" ] \
     && git cat-file -e "${LAST_RELEASE_SHA}^{commit}" 2>/dev/null; then
    # The pathspecs MUST be anchored to the repo root with `:/` — this script
    # runs from scratch-desktop/ (the `cd` at the top), and a bare
    # `scratch-desktop/` pathspec is resolved relative to the cwd, i.e.
    # scratch-desktop/scratch-desktop/, which matches nothing. Without the anchor
    # `git diff --quiet` always saw zero changes and every scheduled run skipped
    # as a no-op (DEV-10749).
    if git diff --quiet "$LAST_RELEASE_SHA" HEAD -- :/scratch-desktop/ :/scratch-git-2/ :/packages/shared-types/; then
      echo "No desktop-relevant changes since last test release ($LAST_RELEASE_SHA). Skipping."
      echo "RELEASE_SKIP=true" > release.env
      exit 0
    fi
    echo "Changes since $LAST_RELEASE_SHA — proceeding with test release."
  else
    echo "No usable prior Source-Commit marker — proceeding (cannot prove a no-op)."
  fi
fi

# 3. Fail if ANY release (draft or published) with this tag already exists.
#    GET /releases/tags only returns published releases, so we additionally
#    scan /releases for drafts with matching tag_name. Duplicate drafts cause
#    tag-collision 422s at finalize time — better to fail fast here.
#    A 404 from the tags endpoint means "no published release yet," which is
#    the happy path — so we don't use --fail-with-body.
TAG_LOOKUP_HTTP=$(curl -sS -o /tmp/tag_lookup_body -w "%{http_code}" \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${NEW_VERSION}")
if [ "$TAG_LOOKUP_HTTP" = "200" ]; then
  echo "ERROR: Published release $NEW_VERSION already exists on GitHub."
  echo "       Bump the version or delete the release manually."
  exit 1
elif [ "$TAG_LOOKUP_HTTP" != "404" ]; then
  echo "ERROR: Unexpected HTTP $TAG_LOOKUP_HTTP from GET /releases/tags/${NEW_VERSION}. Response:"
  cat /tmp/tag_lookup_body
  exit 1
fi

DRAFT_DUP_ID=$(curl -sS --fail-with-body \
  -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100" \
  | jq -r --arg tag "$NEW_VERSION" '.[] | select(.draft == true and .tag_name == $tag) | .id' \
  | head -n1)
if [ -n "$DRAFT_DUP_ID" ]; then
  echo "ERROR: Draft release with tag $NEW_VERSION already exists (id=$DRAFT_DUP_ID)."
  echo "       A prior pipeline likely failed mid-flight. Delete the draft on GitHub"
  echo "       (or wait for the cleanup job of the prior pipeline to run) and retry."
  exit 1
fi

# 4. Update version in package.json (will be picked up by downstream package.sh jobs)
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$SEMVER';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "Updated package.json version to $SEMVER"

# 5. Create the draft release
RELEASE_JSON=$(curl -sS --fail-with-body -X POST -H "Authorization: token $GITHUB_TOKEN" \
  -H "Accept: application/vnd.github.v3+json" \
  "https://api.github.com/repos/${GITHUB_REPO}/releases" \
  -d "$(jq -n \
      --arg tag "$NEW_VERSION" \
      --arg name "${RELEASE_NAME_PREFIX} ${NEW_VERSION}" \
      --arg body "$RELEASE_BODY" \
      --argjson prerelease "$IS_PRERELEASE" \
      '{tag_name: $tag, name: $name, body: $body, draft: true, prerelease: $prerelease}')")

RELEASE_ID=$(echo "$RELEASE_JSON" | jq -r '.id')
if [ -z "$RELEASE_ID" ] || [ "$RELEASE_ID" = "null" ]; then
  echo "ERROR: Failed to create GitHub draft release. Response:"
  echo "$RELEASE_JSON"
  exit 1
fi
RELEASE_UPLOAD_URL=$(echo "$RELEASE_JSON" | jq -r '.upload_url')

echo "Created draft release $NEW_VERSION (id=$RELEASE_ID)"

# 6. Write release.env for downstream jobs
cat > release.env <<ENV
NEW_VERSION=$NEW_VERSION
SEMVER=$SEMVER
RELEASE_ID=$RELEASE_ID
RELEASE_UPLOAD_URL=$RELEASE_UPLOAD_URL
RELEASE_TAG_NAME=$NEW_VERSION
IS_PRERELEASE=$IS_PRERELEASE
RELEASE_SKIP=false
ENV

echo "Wrote release.env:"
cat release.env
