#!/usr/bin/env bash
#
# `yarn install` with retries for transient dependency-fetch failures.
#
# WHY THIS EXISTS
# Every CI job funnels its install through a single un-retried `yarn install`,
# so one network hiccup fails the whole job. Two things can hiccup:
#
#   1. yarn fetching a tarball from the npm registry
#      ("registry.npmjs.org/core-js/-/core-js-3.47.0.tgz: 502 Bad Gateway")
#   2. a postinstall script downloading a binary from GitHub releases —
#      `electron` and `@posthog/cli` both do this in the `[5/5] Building fresh
#      packages` phase ("RequestError: socket hang up", "Response code 503")
#
# Between 2026-08-12 and 2026-08-13 that cost seven job failures across build,
# migrations, and CLI integration — including two that silently blocked the
# test deploy, because a failed `run migrations` job skips the whole deploy
# stage. Every one of those errors is retryable.
#
# USAGE
#   scripts/ci/yarn-install-with-retry.sh [extra yarn install args...]
#
# Runs `yarn install` in the CURRENT working directory, so callers keep their
# existing cwd semantics. `--frozen-lockfile` and `--network-timeout` are always
# applied; everything else is passed through (e.g. `--cache-folder .yarn
# --prefer-offline`, or `--ignore-engines` for the desktop packaging build).
#
# A lockfile that genuinely needs updating is NOT retried — that failure is
# deterministic, and retrying it would just burn three attempts before failing.
#
# TUNABLES (env)
#   YARN_INSTALL_ATTEMPTS             total attempts, default 3
#   YARN_INSTALL_RETRY_DELAY_SECONDS  base backoff, default 15 (linear: 15s, 30s)
#   YARN_INSTALL_NETWORK_TIMEOUT_MS   yarn --network-timeout, default 300000

set -uo pipefail

total_install_attempts="${YARN_INSTALL_ATTEMPTS:-3}"
retry_backoff_base_seconds="${YARN_INSTALL_RETRY_DELAY_SECONDS:-15}"
yarn_network_timeout_milliseconds="${YARN_INSTALL_NETWORK_TIMEOUT_MS:-300000}"

yarn_install_arguments=(
  install
  --frozen-lockfile
  --network-timeout "$yarn_network_timeout_milliseconds"
  "$@"
)

yarn_output_log_file="$(mktemp "${TMPDIR:-/tmp}/yarn-install-with-retry.XXXXXX")"
trap 'rm -f "$yarn_output_log_file"' EXIT

# Yarn 1 writes node_modules/.yarn-integrity during the link phase, i.e. BEFORE
# it builds fresh packages. A postinstall that dies therefore leaves an
# integrity file claiming the install is complete, and the next `yarn install`
# reports "Already up-to-date" without ever re-running the postinstall that
# failed. Deleting it forces the retry to actually redo the work.
remove_stale_yarn_integrity_files() {
  rm -f node_modules/.yarn-integrity
  if [ -n "${CI_PROJECT_DIR:-}" ]; then
    rm -f "${CI_PROJECT_DIR}/node_modules/.yarn-integrity"
  fi
}

for attempt_number in $(seq 1 "$total_install_attempts"); do
  echo "==> yarn install (attempt ${attempt_number}/${total_install_attempts}) in $(pwd)"

  yarn "${yarn_install_arguments[@]}" 2>&1 | tee "$yarn_output_log_file"
  yarn_exit_code="${PIPESTATUS[0]}"

  if [ "$yarn_exit_code" -eq 0 ]; then
    exit 0
  fi

  if grep -q "lockfile needs to be updated" "$yarn_output_log_file"; then
    echo "==> yarn install failed because the lockfile is out of date. That is a"
    echo "    real, deterministic failure — not retrying. Run \`yarn install\` locally"
    echo "    and commit the updated yarn.lock."
    exit "$yarn_exit_code"
  fi

  if [ "$attempt_number" -eq "$total_install_attempts" ]; then
    echo "==> yarn install failed ${total_install_attempts} times (exit ${yarn_exit_code}). Giving up."
    echo "    If the errors above are registry/GitHub-releases 5xx, 'socket hang up',"
    echo "    or EOF, this is the known CI dependency-fetch flake and a job retry"
    echo "    should clear it."
    exit "$yarn_exit_code"
  fi

  backoff_seconds=$((retry_backoff_base_seconds * attempt_number))
  echo "==> yarn install failed (exit ${yarn_exit_code}). Retrying in ${backoff_seconds}s..."
  remove_stale_yarn_integrity_files
  sleep "$backoff_seconds"
done
