#!/usr/bin/env bash
#
# credential-helpers.sh — secret-handling for /connector-build-prepare and /connector-build-execute.
#
# THE WHOLE POINT: these helpers read/generate secrets and hand them straight to the
# browser (gstack `$B`) or to a child command. They NEVER print a secret value to stdout/stderr.
# So an agent that *runs* these helpers never has the password/token in its context — it only sees
# confirmations like "set TODOIST_PASSWORD in todoist (value hidden)". That is what makes fully
# automated registration + login safe and removes the agent's password-typing refusal.
#
# Secrets live in the shared test-credentials store: Secret Manager in the GCP project
# whalesync-test-credentials (override with TEST_CREDENTIALS_PROJECT), shared with the Whalesync
# repo (its docs/test-credentials.md describes the store). One secret per test account, named after
# the service in lowercase (`todoist`; a second account for a service gets a suffix, `zoho-eu`).
# Each value is a .env file: comment lines describing the account, then <SVC>_<FIELD>='value'
# lines, where <SVC> is the account name before any '-', upper-cased (TODOIST_ for todoist, ZOHO_
# for zoho-eu; Whalesync also uses IAPP_<SVC>_). The store's own tools skip any other variable
# name, so writes here refuse them.
# Values are single-quoted; generated passwords exclude the ' char.
#
# Works as your own login or as your read-only laptop service account (both can read and write
# this project). Each call spends about a second in gcloud.
#
# CLI usage (what the agent calls):
#   bash credential-helpers.sh require      <account> VAR [VAR...]          # fail fast if missing
#   bash credential-helpers.sh gen-password <account> VAR                   # generate+store, no echo
#   bash credential-helpers.sh set-secret   <account> VAR                   # reads value from stdin
#   bash credential-helpers.sh enter-secret <account> VAR '#sel' ['#sel2']  # fill field(s)
#   bash credential-helpers.sh type-secret  <account> VAR                   # type into focused element
#   bash credential-helpers.sh run          <account> -- CMD [ARGS...]      # CMD sees the account's vars
#   bash credential-helpers.sh set-header   <account>                       # comment lines from stdin
#   bash credential-helpers.sh names        <account>                       # stored var names, no values
#   bash credential-helpers.sh list                                         # every stored account
#   bash credential-helpers.sh import <old-env-file> <account> <OLD_PREFIX> # e.g. CB_TODOIST_ → TODOIST_
set -euo pipefail

CB_PROJECT="${TEST_CREDENTIALS_PROJECT:-whalesync-test-credentials}"

cb_repo_root() { git rev-parse --show-toplevel; }

# Locate the gstack browse binary ($B), repo-local first, then $HOME.
cb_browse() {
  local root; root="$(cb_repo_root)"
  if [ -x "$root/.claude/skills/gstack/browse/dist/browse" ]; then
    echo "$root/.claude/skills/gstack/browse/dist/browse"
  else
    echo "$HOME/.claude/skills/gstack/browse/dist/browse"
  fi
}

cb_gcloud() { gcloud --project="$CB_PROJECT" --billing-project="$CB_PROJECT" --quiet "$@"; }

cb_check_account_name() {
  [[ "${1:-}" =~ ^[A-Za-z0-9_-]{1,255}$ ]] && return 0
  echo "ERROR: account must be letters, digits, '-' or '_' (got '${1:-}')" >&2
  return 1
}

# TODOIST_ for todoist, ZOHO_ for zoho-eu: the variables the store treats as this account's.
cb_var_prefix() { printf '%s_' "$(printf '%s' "${1%%-*}" | tr '[:lower:]' '[:upper:]')"; }

cb_check_var_name() {
  local account="$1" var="$2" prefix; prefix="$(cb_var_prefix "$account")"
  [[ "$var" =~ ^[A-Z][A-Z0-9_]*$ && ( "$var" == "$prefix"* || "$var" == "IAPP_$prefix"* ) ]] && return 0
  echo "ERROR: '$var' must be upper-case and start with $prefix or IAPP_$prefix (the store's tools skip any other name)" >&2
  return 1
}

# Returns 0 if the account's secret exists, 1 if it doesn't, 2 if the store can't be read. Only an
# explicit NOT_FOUND counts as "doesn't exist": a transient failure read as "missing" would make a
# write start from an empty payload and drop every other variable in a shared secret.
cb_account_state() {
  local describe_error_output
  if describe_error_output="$(cb_gcloud secrets describe "$1" --format='value(name)' 2>&1 >/dev/null)"; then return 0; fi
  [[ "$describe_error_output" == *NOT_FOUND* ]] && return 1
  echo "ERROR: can't read '$1' in $CB_PROJECT (${describe_error_output##*$'\n'})." >&2
  echo "Check 'gcloud auth list': it needs your own whalesync.com login or your read-only laptop" >&2
  echo "service account (role_developers / role_readonly_sa)." >&2
  return 2
}

# Latest version of the account's .env payload, or nothing if the account has no secret yet (or a
# secret with no enabled version, which a create whose first write failed leaves behind).
# Only ever captured into a variable by the functions below; never reaches the terminal.
cb_read_payload() {
  local state=0 enabled_versions
  cb_account_state "$1" || state=$?
  case "$state" in
    0) cb_gcloud secrets versions access latest --secret="$1" 2>/dev/null && return 0
       if ! enabled_versions="$(cb_gcloud secrets versions list "$1" --filter='state:ENABLED' --limit=1 --format='value(name)' 2>/dev/null)"; then
         echo "ERROR: can't read the versions of '$1' in $CB_PROJECT" >&2; return 1
       fi
       [ -z "$enabled_versions" ] && return 0
       echo "ERROR: can't read the latest version of '$1' in $CB_PROJECT" >&2; return 1;;
    1) return 0;;
    *) return 1;;
  esac
}

cb_read_existing_payload() {
  local payload
  payload="$(cb_read_payload "$1")" || return 1
  if [ -z "$payload" ]; then
    echo "ERROR: no '$1' secret in $CB_PROJECT. Provision the account with /connector-build-prepare, or move" >&2
    echo "it in from an old .env.connector-build with 'import' (see connector-build/test-accounts-mechanism.md)." >&2
    return 1
  fi
  printf '%s' "$payload"
}

# Saves the payload as a new version, creating the secret first if needed. Earlier versions stay readable.
cb_write_payload() {
  local account="$1" payload="$2" state=0
  cb_account_state "$account" || state=$?
  if [ "$state" -eq 2 ]; then return 1; fi
  if [ "$state" -eq 1 ]; then
    cb_gcloud secrets create "$account" --replication-policy=automatic >/dev/null || return 1
  fi
  printf '%s\n' "$payload" | cb_gcloud secrets versions add "$account" --data-file=- >/dev/null || return 1
}

cb_default_header() {
  printf '%s\n' \
    "# ${1} test account for Scratch connector builds (/connector-build-prepare). Burner data: create/edit/delete freely." \
    "# Login, plan, and where to regenerate each key: connector-build/provisioning-notes/${1%%-*}.md in the Spinner repo," \
    "# or the connector's STATE.md once it is built."
}

# Value of VAR in a payload, using the store's parsing rules (optional `export`, matching quotes stripped).
# The last assignment wins, as when the file is sourced and in the store's own parsers.
cb_value_in_payload() {
  local payload="$1" var="$2" line value last_matching_value="" found_matching_line=1
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    [ "${BASH_REMATCH[2]}" = "$var" ] || continue
    value="${BASH_REMATCH[3]}"
    value="${value%"${value##*[![:space:]]}"}"
    if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
    last_matching_value="$value"
    found_matching_line=0
  done <<<"$payload"
  if [ "$found_matching_line" -eq 0 ]; then printf '%s' "$last_matching_value"; fi
  return "$found_matching_line"
}

cb_names_in_payload() {
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)= ]] && echo "${BASH_REMATCH[2]}"
  done <<<"$1"
  return 0
}

cb_check_value() {
  case "$2" in
    *\'*|*$'\n'*) echo "ERROR: value for $1 contains a single quote or a newline; not supported" >&2; return 1;;
  esac
}

# set VAR='value' in the account's secret (replacing any earlier VAR line), as a new version.
cb_set_var() {
  local account="$1" var="$2" value="$3" payload updated_payload="" line
  cb_check_account_name "$account" || return 1
  cb_check_var_name "$account" "$var" || return 1
  cb_check_value "$var" "$value" || return 1
  payload="$(cb_read_payload "$account")" || return 1
  [ -n "$payload" ] || payload="$(cb_default_header "$account")"
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?${var}= ]] && continue
    updated_payload+="$line"$'\n'
  done <<<"$payload"
  updated_payload+="${var}='${value}'"
  cb_write_payload "$account" "$updated_payload"
}

# require ACCOUNT VAR [VAR...] — fail fast, naming exactly which vars are missing/empty.
cb_require() {
  local account="$1"; shift
  cb_check_account_name "$account" || return 1
  local payload missing=() v value
  payload="$(cb_read_existing_payload "$account")" || return 1
  for v in "$@"; do
    value="$(cb_value_in_payload "$payload" "$v")" || value=""
    [ -n "$value" ] || missing+=("$v")
  done
  if [ "${#missing[@]}" -gt 0 ]; then
    echo "ERROR: missing/empty in the '$account' secret ($CB_PROJECT): ${missing[*]}" >&2
    return 1
  fi
  echo "ok: all present in $account (${*})"
}

# set-secret ACCOUNT VAR  (value read from stdin) — store VAR, single-quoted. No echo.
cb_set_secret() {
  local account="$1" var="$2" value
  # All of stdin, so a multi-line value is rejected below instead of cut to its first line.
  value="$(cat)"
  [ -n "$value" ] || { echo "ERROR: no value on stdin for $var" >&2; return 1; }
  cb_set_var "$account" "$var" "$value" || return 1
  echo "set $var in $account (value hidden)"
}

# gen-password ACCOUNT VAR — generate a strong random password, store it, never echo it.
# Reads a FIXED amount of randomness (no `tr </dev/urandom | head`, which SIGPIPEs under
# pipefail). base64 alphabet is single-quote-safe; the Aa1! suffix guarantees complexity.
cb_gen_and_store_password() {
  local account="$1" var="$2" core pw
  core="$( { openssl rand -base64 48 2>/dev/null || head -c 48 /dev/urandom | base64; } | LC_ALL=C tr -dc 'A-Za-z0-9' )"
  pw="${core:0:24}Aa1!"
  printf '%s' "$pw" | cb_set_secret "$account" "$var"
}

cb_read_var() {
  local account="$1" var="$2" payload value
  cb_check_account_name "$account" || return 1
  payload="$(cb_read_existing_payload "$account")" || return 1
  value="$(cb_value_in_payload "$payload" "$var")" || value=""
  [ -n "$value" ] || { echo "ERROR: missing $var in the '$account' secret" >&2; return 1; }
  printf '%s' "$value"
}

# enter-secret ACCOUNT VAR SELECTOR [SELECTOR...] — fill the value into each field. No echo.
cb_enter_secret_into_field() {
  local account="$1" var="$2"; shift 2
  local value B sel
  value="$(cb_read_var "$account" "$var")" || return 1
  B="$(cb_browse)"
  # CB_BROWSE_FLAGS lets the caller target a non-default daemon, e.g. CB_BROWSE_FLAGS=--headed
  for sel in "$@"; do "$B" fill "$sel" "$value" ${CB_BROWSE_FLAGS:-} >/dev/null; done
  echo "entered $var into $# field(s) (value hidden)"
}

# type-secret ACCOUNT VAR — type the value into the currently-focused element. No echo.
cb_type_secret() {
  local account="$1" var="$2" value B
  value="$(cb_read_var "$account" "$var")" || return 1
  B="$(cb_browse)"; "$B" type "$value" ${CB_BROWSE_FLAGS:-} >/dev/null
  echo "typed $var into focused element (value hidden)"
}

# run ACCOUNT -- CMD [ARGS...] — run CMD with the account's <SVC>_* vars exported. Only those
# names are exported (the store's rule), so a stored PATH or NODE_OPTIONS can't change what runs.
# For a curl or CLI call that needs a token:  run todoist -- sh -c 'curl -H "Authorization: Bearer $TODOIST_API_TOKEN" …'
cb_run() {
  local account="$1"; shift
  [ "${1:-}" = "--" ] && shift
  [ "$#" -gt 0 ] || { echo "usage: credential-helpers.sh run <account> -- CMD [ARGS...]" >&2; return 2; }
  cb_check_account_name "$account" || return 1
  local payload prefix name value
  payload="$(cb_read_existing_payload "$account")" || return 1
  prefix="$(cb_var_prefix "$account")"
  # Drop same-prefix vars the caller already had, so a var missing from the secret fails in CMD
  # instead of silently using a stale value from the caller's shell.
  for name in $(compgen -e); do
    [[ "$name" == "$prefix"* || "$name" == "IAPP_$prefix"* ]] && unset "$name"
  done
  for name in $(cb_names_in_payload "$payload"); do
    [[ "$name" == "$prefix"* || "$name" == "IAPP_$prefix"* ]] || continue
    value="$(cb_value_in_payload "$payload" "$name")" || continue
    export "$name=$value"
  done
  exec "$@"
}

# set-header ACCOUNT — replace the secret's leading comment block with the comment lines on stdin
# (which account it is, the login, where to get a new key, when it expires). Never put a value here.
cb_set_header() {
  local account="$1" header line payload body="" in_header=1
  cb_check_account_name "$account" || return 1
  header="$(cat)"
  [[ "$header" =~ (^|$'\n')[[:space:]]*# ]] || { echo "ERROR: no comment lines on stdin" >&2; return 1; }
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]] && continue
    echo "ERROR: header lines must be comments starting with '#'" >&2; return 1
  done <<<"$header"
  payload="$(cb_read_existing_payload "$account")" || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    if [ "$in_header" -eq 1 ] && [[ -z "${line//[[:space:]]/}" || "$line" =~ ^[[:space:]]*# ]]; then continue; fi
    in_header=0
    body+="$line"$'\n'
  done <<<"$payload"
  cb_write_payload "$account" "${header}"$'\n'"${body%$'\n'}" || return 1
  echo "updated the header of $account"
}

# names ACCOUNT — the variable names stored for the account. Never the values.
cb_names() {
  local payload
  cb_check_account_name "$1" || return 1
  payload="$(cb_read_existing_payload "$1")" || return 1
  cb_names_in_payload "$payload"
}

cb_list() { cb_gcloud secrets list --format='value(name.basename())'; }

# import OLD_ENV_FILE ACCOUNT OLD_PREFIX — move one account's lines out of a pre-store
# .env.connector-build (e.g. a copy of the old 1Password note) into a new secret, renaming
# OLD_PREFIX to the store's prefix (CB_TODOIST_API_TOKEN → TODOIST_API_TOKEN). Refuses to touch an
# existing secret: if the store already has one for the service, it may be a different account.
cb_import() {
  local file="$1" account="$2" old_prefix="$3" prefix line name value body="" imported=() existing_payload
  [ -f "$file" ] || { echo "ERROR: no such file: $file" >&2; return 1; }
  cb_check_account_name "$account" || return 1
  [[ "$old_prefix" =~ ^[A-Z][A-Z0-9_]*_$ ]] || { echo "ERROR: OLD_PREFIX must look like CB_TODOIST_" >&2; return 1; }
  existing_payload="$(cb_read_payload "$account")" || return 1
  if [ -n "$existing_payload" ]; then
    echo "ERROR: '$account' already exists in $CB_PROJECT. If it's a different account, import under a" >&2
    echo "suffixed name (e.g. $account-scratch); if it's the same one, add missing vars with set-secret." >&2
    return 1
  fi
  prefix="$(cb_var_prefix "$account")"
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    name="${BASH_REMATCH[2]}"
    [[ "$name" == "$old_prefix"* ]] || continue
    value="$(cb_value_in_payload "$line" "$name")" || value=""
    [ -n "$value" ] || continue
    cb_check_value "$name" "$value" || return 1
    body+="${prefix}${name#"$old_prefix"}='${value}'"$'\n'
    imported+=("${prefix}${name#"$old_prefix"}")
  done <"$file"
  [ "${#imported[@]}" -gt 0 ] || { echo "ERROR: no non-empty ${old_prefix}* lines in $file" >&2; return 1; }
  cb_write_payload "$account" "$(cb_default_header "$account")"$'\n'"${body%$'\n'}" || return 1
  echo "imported ${#imported[@]} var(s) into $account: ${imported[*]}"
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
    run)           cb_run "$@";;
    set-header)    cb_set_header "$@";;
    names)         cb_names "$@";;
    list)          cb_list;;
    import)        cb_import "$@";;
    browse-bin)    cb_browse;;
    *) echo "usage: credential-helpers.sh {require|gen-password|set-secret|enter-secret|type-secret|run|set-header|names|list|import|browse-bin} ..." >&2; exit 2;;
  esac
fi
