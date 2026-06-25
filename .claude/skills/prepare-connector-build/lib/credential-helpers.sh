#!/usr/bin/env bash
#
# credential-helpers.sh — secret-handling for /prepare-connector-build and /connector-build.
#
# THE WHOLE POINT: these helpers read/generate secrets and hand them straight to the
# browser (gstack `$B`). They NEVER print a secret value to stdout/stderr. So an agent
# that *runs* these helpers never has the password/token in its context — it only sees
# confirmations like "set CB_FOO_PASSWORD (value hidden)". That is what makes fully
# automated registration + login safe and removes the agent's password-typing refusal.
#
# Secrets live in <repo>/.env.connector-build (gitignored, distributed via 1Password).
# Values are single-quoted (CB_FOO='...'); generated passwords exclude the ' char.
#
# CLI usage (what the agent calls):
#   bash credential-helpers.sh require   CB_X_API_TOKEN [CB_X_...]     # fail fast if missing
#   bash credential-helpers.sh gen-password CB_X_PASSWORD             # generate+store, no echo
#   bash credential-helpers.sh set-secret   CB_X_API_TOKEN            # reads value from stdin
#   bash credential-helpers.sh enter-secret CB_X_PASSWORD '#password' ['#confirm']  # fill field(s)
#   bash credential-helpers.sh type-secret  CB_X_PASSWORD             # type into focused element
#   bash credential-helpers.sh update-sample CB_X_PASSWORD CB_X_API_TOKEN           # add to .sample
set -euo pipefail

cb_repo_root()   { git rev-parse --show-toplevel; }
# Paths default to the repo root; override with CB_ENV_FILE / CB_SAMPLE_FILE (used in tests).
cb_env_file()    { echo "${CB_ENV_FILE:-$(cb_repo_root)/.env.connector-build}"; }
cb_sample_file() { echo "${CB_SAMPLE_FILE:-$(cb_repo_root)/.env.connector-build.sample}"; }

# Locate the gstack browse binary ($B), repo-local first, then $HOME.
cb_browse() {
  local root; root="$(cb_repo_root)"
  if [ -x "$root/.claude/skills/gstack/browse/dist/browse" ]; then
    echo "$root/.claude/skills/gstack/browse/dist/browse"
  else
    echo "$HOME/.claude/skills/gstack/browse/dist/browse"
  fi
}

cb_require_env_file() {
  local f; f="$(cb_env_file)"
  if [ ! -f "$f" ]; then
    echo "ERROR: $f not found." >&2
    echo "Copy the shared secrets from the 1Password note 'Scratch Connector QA — .env.connector-build'" >&2
    echo "by hand into: $f" >&2
    return 1
  fi
}

# Load the env file into the shell (vars become available; nothing is printed).
cb_load_env() {
  cb_require_env_file || return 1
  set -a; # shellcheck disable=SC1090
  source "$(cb_env_file)"; set +a
}

# require VAR [VAR...] — fail fast, naming exactly which vars are missing/empty.
cb_require() {
  cb_load_env || return 1
  local missing=() v
  for v in "$@"; do [ -z "${!v:-}" ] && missing+=("$v"); done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "ERROR: missing/empty in $(cb_env_file): ${missing[*]}" >&2
    echo "Fill them (or copy the latest file from the 1Password note) and re-run." >&2
    return 1
  fi
  echo "ok: all present (${*})"
}

# set-secret VAR  (value read from stdin) — idempotently set VAR, single-quoted. No echo.
cb_set_secret() {
  local var="$1" value f tmp
  IFS= read -r value || true
  case "$value" in *\'*) echo "ERROR: value for $var contains a single quote; not supported" >&2; return 1;; esac
  f="$(cb_env_file)"; touch "$f"; chmod 600 "$f" 2>/dev/null || true
  tmp="$(mktemp)"; grep -vE "^${var}=" "$f" > "$tmp" || true
  printf "%s='%s'\n" "$var" "$value" >> "$tmp"
  mv "$tmp" "$f"
  echo "set $var (value hidden)"
}

# gen-password VAR — generate a strong random password, store it, never echo it.
# Reads a FIXED amount of randomness (no `tr </dev/urandom | head`, which SIGPIPEs under
# pipefail). base64 alphabet is single-quote-safe; the Aa1! suffix guarantees complexity.
cb_gen_and_store_password() {
  local var="$1" core pw
  core="$( { openssl rand -base64 48 2>/dev/null || head -c 48 /dev/urandom | base64; } | LC_ALL=C tr -dc 'A-Za-z0-9' )"
  pw="${core:0:24}Aa1!"
  printf '%s' "$pw" | cb_set_secret "$var"
}

# enter-secret VAR SELECTOR [SELECTOR...] — fill the value into each field. No echo.
cb_enter_secret_into_field() {
  local var="$1"; shift
  cb_load_env || return 1
  : "${!var:?missing $var in env file}"
  local B sel; B="$(cb_browse)"
  for sel in "$@"; do "$B" fill "$sel" "${!var}" >/dev/null; done
  echo "entered $var into $# field(s) (value hidden)"
}

# type-secret VAR — type the value into the currently-focused element. No echo.
cb_type_secret() {
  local var="$1" B; cb_load_env || return 1
  : "${!var:?missing $var in env file}"
  B="$(cb_browse)"; "$B" type "${!var}" >/dev/null
  echo "typed $var into focused element (value hidden)"
}

# update-sample VAR [VAR...] — append var names (empty values) to .env.connector-build.sample
# if not already present. Keeps the committed template in sync; never writes a value.
cb_update_sample() {
  local f v; f="$(cb_sample_file)"; touch "$f"
  for v in "$@"; do
    grep -qE "^${v}=" "$f" || printf "%s=''\n" "$v" >> "$f"
  done
  echo "synced ${#@} var name(s) into $(basename "$f")"
}

# ---- CLI dispatch ----
if [ "${BASH_SOURCE[0]:-$0}" = "$0" ]; then
  cmd="${1:-}"; shift || true
  case "$cmd" in
    require)       cb_require "$@";;
    gen-password)  cb_gen_and_store_password "$@";;
    set-secret)    cb_set_secret "$@";;
    enter-secret)  cb_enter_secret_into_field "$@";;
    type-secret)   cb_type_secret "$@";;
    update-sample) cb_update_sample "$@";;
    browse-bin)    cb_browse;;
    *) echo "usage: credential-helpers.sh {require|gen-password|set-secret|enter-secret|type-secret|update-sample|browse-bin} ..." >&2; exit 2;;
  esac
fi
