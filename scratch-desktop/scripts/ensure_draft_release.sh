#!/bin/bash
# shellcheck shell=bash
#
# Sourced helper. Verifies that the draft GitHub release referenced by
# $RELEASE_ID still exists. If it doesn't (e.g. Cleanup deleted it between a
# failed Upload and its retry), looks up a draft with tag $NEW_VERSION or
# creates a fresh one with the same tag, then re-exports $RELEASE_ID and
# $RELEASE_UPLOAD_URL so the caller can proceed against the live release.
#
# Inputs (env):
#   RELEASE_ID            from bootstrap dotenv (may be stale)
#   NEW_VERSION           release tag, e.g. v1.2.3-test
#   IS_PRERELEASE         "false" for both channels (test releases are full releases so the dedicated
#                         test repo's "latest" pointer resolves to them — DEV-11320)
#   GITHUB_REPO           channel's release repo (defaults to whalesync/scratch-desktop)
#   GITHUB_TOKEN          required to read/create releases
#
# Outputs (exported env):
#   RELEASE_ID            id of a live draft release with tag $NEW_VERSION
#   RELEASE_UPLOAD_URL    upload_url template for that release
#
# Why this exists: Cleanup test/prod desktop release runs at the end of every
# pipeline (when: always) and deletes the draft if it's still unpublished. When
# a transient failure forces a retry of Upload or Finalize, the draft is gone
# and the retry hits HTTP 404 — see DEV-10257. This helper makes those two
# jobs idempotent against a missing draft.

ensure_draft_release() {
  : "${NEW_VERSION:?NEW_VERSION required}"
  : "${GITHUB_TOKEN:?GITHUB_TOKEN required}"

  local repo="${GITHUB_REPO:-whalesync/scratch-desktop}"
  local lookup_http

  # 1. Try the RELEASE_ID we were handed. If it resolves to a live draft, we
  #    just need to refresh RELEASE_UPLOAD_URL from the response and return.
  if [ -n "${RELEASE_ID:-}" ]; then
    lookup_http=$(curl -sS -o /tmp/ensure_release_body -w "%{http_code}" \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github.v3+json" \
      "https://api.github.com/repos/${repo}/releases/${RELEASE_ID}")
    if [ "$lookup_http" = "200" ]; then
      local is_draft
      is_draft=$(jq -r '.draft' < /tmp/ensure_release_body)
      if [ "$is_draft" != "true" ]; then
        echo "ERROR: Release id=$RELEASE_ID is already published (draft=$is_draft). Refusing to modify."
        return 1
      fi
      RELEASE_UPLOAD_URL=$(jq -r '.upload_url' < /tmp/ensure_release_body)
      export RELEASE_ID RELEASE_UPLOAD_URL
      return 0
    fi
    if [ "$lookup_http" != "404" ]; then
      echo "ERROR: Unexpected HTTP $lookup_http looking up release id=$RELEASE_ID. Response:"
      cat /tmp/ensure_release_body
      return 1
    fi
    echo "Release id=$RELEASE_ID is gone (HTTP 404) — likely cleaned up. Looking up draft by tag $NEW_VERSION..."
  fi

  # 2. No live id. Scan recent releases for a draft with our tag — a parallel
  #    retry may have already re-created it.
  local releases_json existing
  releases_json=$(curl -sS --fail-with-body \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${repo}/releases?per_page=100")
  existing=$(echo "$releases_json" | jq -c --arg tag "$NEW_VERSION" \
    'map(select(.tag_name == $tag)) | .[0] // empty')
  if [ -n "$existing" ]; then
    local existing_draft
    existing_draft=$(echo "$existing" | jq -r '.draft')
    if [ "$existing_draft" != "true" ]; then
      echo "ERROR: Release $NEW_VERSION is already published (draft=$existing_draft). Refusing to modify."
      return 1
    fi
    RELEASE_ID=$(echo "$existing" | jq -r '.id')
    RELEASE_UPLOAD_URL=$(echo "$existing" | jq -r '.upload_url')
    echo "Found existing draft for $NEW_VERSION (id=$RELEASE_ID)."
    export RELEASE_ID RELEASE_UPLOAD_URL
    return 0
  fi

  # 3. No draft. Recreate one with the same tag. Match the body bootstrap uses
  #    so a recreated draft looks the same as the original.
  echo "No draft release found for $NEW_VERSION; creating a new one."
  local is_prerelease=${IS_PRERELEASE:-false}
  local release_body=""
  if [ "$is_prerelease" = "true" ]; then
    release_body="Test release pointing at test-api.scratch.md. Not for end users."
  fi

  local create_http
  create_http=$(curl -sS -o /tmp/ensure_release_body -w "%{http_code}" -X POST \
    -H "Authorization: token $GITHUB_TOKEN" \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/${repo}/releases" \
    -d "$(jq -n \
        --arg tag "$NEW_VERSION" \
        --arg name "Scratch Desktop ${NEW_VERSION}" \
        --arg body "$release_body" \
        --argjson prerelease "$is_prerelease" \
        '{tag_name: $tag, name: $name, body: $body, draft: true, prerelease: $prerelease}')")

  if [ "$create_http" -ge 200 ] && [ "$create_http" -lt 300 ]; then
    RELEASE_ID=$(jq -r '.id' < /tmp/ensure_release_body)
    RELEASE_UPLOAD_URL=$(jq -r '.upload_url' < /tmp/ensure_release_body)
    echo "Created draft release $NEW_VERSION (id=$RELEASE_ID)."
    export RELEASE_ID RELEASE_UPLOAD_URL
    return 0
  fi

  # 4. 422 from POST /releases means the tag is in use — a parallel job
  #    created the draft between our step-2 list and step-3 POST. Re-fetch
  #    and use whatever they created.
  if [ "$create_http" = "422" ]; then
    echo "POST returned 422 — another job likely created the draft. Re-fetching..."
    releases_json=$(curl -sS --fail-with-body \
      -H "Authorization: token $GITHUB_TOKEN" \
      -H "Accept: application/vnd.github.v3+json" \
      "https://api.github.com/repos/${repo}/releases?per_page=100")
    existing=$(echo "$releases_json" | jq -c --arg tag "$NEW_VERSION" \
      'map(select(.tag_name == $tag and .draft == true)) | .[0] // empty')
    if [ -n "$existing" ]; then
      RELEASE_ID=$(echo "$existing" | jq -r '.id')
      RELEASE_UPLOAD_URL=$(echo "$existing" | jq -r '.upload_url')
      echo "Found draft (id=$RELEASE_ID) created by parallel job."
      export RELEASE_ID RELEASE_UPLOAD_URL
      return 0
    fi
    echo "ERROR: POST returned 422 but no draft with tag $NEW_VERSION found. Original response:"
    cat /tmp/ensure_release_body
    return 1
  fi

  echo "ERROR: Failed to create draft release (HTTP $create_http). Response:"
  cat /tmp/ensure_release_body
  return 1
}
