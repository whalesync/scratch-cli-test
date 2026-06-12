#!/bin/bash
set -euo pipefail

# Connects to the GCP database for a given environment as the dedicated read-only
# Postgres user ("readonly") and runs queries safely. This is intended for
# read-only inspection of a live database — debugging Scratch user issues and
# investigating live data while building features, including by automated agents
# like Claude — so it layers a few guardrails on top of the role's own
# SELECT-only privileges:
#   - default_transaction_read_only=on  (belt-and-suspenders; no writes possible
#                                        even if the role's grants ever drift)
#   - statement_timeout=30s             (we tunnel to the prod *primary*, so a
#                                        runaway query can't pile load on it)
#   - application_name=claude-readonly  (so the queries are identifiable in logs
#                                        and Cloud SQL Query Insights)
#
# The password and DB host both come from Secret Manager (READONLY_DB_PASSWORD,
# DB_HOST), so they never live in this repo or your shell history — and reading
# the host from a secret means this script needs no Cloud SQL Admin API call,
# which a least-privilege principal (e.g. the read-only SA, whose gcloud quota
# project is the bare wsv1-dev-identity project) can't make. The username is the
# literal "readonly" and the database is "scratchpad" (see
# terraform/modules/cloudsql and terraform/modules/env/secrets.tf).
#
# Prerequisites:
#   - Install and authenticate the gcloud CLI
#   - Install psql:  brew install libpq && brew link --force libpq
#
# Usage:
#   # One-shot query (results printed, tunnel torn down on exit):
#   ./connect_to_gcp_db_readonly.sh production "SELECT count(*) FROM \"User\";"
#
#   # Interactive psql session (quit with \q to tear down the tunnel):
#   ./connect_to_gcp_db_readonly.sh production
#
# arg1: environment: 'test'|'staging'|'production'
# arg2: (optional) SQL to run once. If omitted, opens an interactive psql shell.

if [ $# -lt 1 ]; then
  echo "usage: $0 <environment> [sql]"
  echo "You must provide the name of the environment as the first argument: 'test', 'staging', or 'production'."
  echo "Optionally provide a SQL string as the second argument to run a single query; otherwise an interactive psql shell opens."
  exit 1
fi

# Ensure gcloud is installed
if ! command -v gcloud &>/dev/null; then
  echo "gcloud could not be found, please install and authenticate."
  exit 1
fi

# Ensure psql is installed
if ! command -v psql &>/dev/null; then
  echo "psql could not be found, please install it."
  echo "> brew install libpq && brew link --force libpq"
  exit 1
fi

ENVIRONMENT=$1
QUERY=${2:-}
GCP_PROJECT="spv1eu-${ENVIRONMENT}"

# Validate environment argument
if [[ "$ENVIRONMENT" != "test" && "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
  echo "Error: Invalid environment '$ENVIRONMENT'"
  echo "Allowed values: 'test', 'staging', or 'production'"
  exit 1
fi

# The read-only user and database name are fixed by terraform (see
# terraform/modules/cloudsql/main.tf and terraform/modules/env/secrets.tf).
# The password and the DB host (primary instance private IP) are stored in
# Secret Manager — reading the host from a secret rather than discovering it via
# `gcloud sql instances list` keeps this script off the Cloud SQL Admin API.
READONLY_DB_USER="readonly"
DB_NAME="scratchpad"
READONLY_DB_PASSWORD=$(gcloud secrets versions access latest --project="${GCP_PROJECT}" --secret=READONLY_DB_PASSWORD)

# The primary Cloud SQL instance's private IP, written to Secret Manager by terraform (see DB_HOST in
# terraform/modules/env/secrets.tf).
DB_HOST=$(gcloud secrets versions access latest --project="${GCP_PROJECT}" --secret=DB_HOST)
if [ -z "$DB_HOST" ]; then
  echo "Error: failed to read the primary database host (DB_HOST secret) for ${ENVIRONMENT}"
  exit 1
fi

LOCAL_HOSTNAME="127.0.0.1"
LOCAL_PORT=5433
REMOTE_PORT=5432

# Start the SSH tunnel through the cloudsql-proxy VM via IAP.
echo "Starting SSH tunnel to gcp VM for $ENVIRONMENT: $DB_HOST"
gcloud compute ssh cloudsql-proxy --project "${GCP_PROJECT}" --zone europe-west1-b --tunnel-through-iap -- -N -L "$LOCAL_PORT:$DB_HOST:$REMOTE_PORT" &
# Remember the PID of the background process so we can kill it later.
ssh_tunnel_to_proxy_pid=$!

# Tear down the SSH tunnel when this process exits.
function cleanup {
  echo "Shutting down the SSH tunnel..."
  kill "$ssh_tunnel_to_proxy_pid" 2>/dev/null || true
  exit
}
trap cleanup EXIT

# Wait for the local forwarded port to start listening.
counter=0
sleep=5
timeout=600
while ! lsof -iTCP:$LOCAL_PORT -s tcp:listen >/dev/null; do
  echo "Waiting for port $LOCAL_PORT to be open..."
  sleep $sleep
  counter=$((counter + sleep))
  if [ $counter -ge $timeout ]; then
    echo "Timeout after $timeout seconds. Port $LOCAL_PORT is still not open."
    echo "Failed to set up SSH tunnel to GCP VM!"
    exit 1
  fi
done

echo "SSH tunnel to GCP VM started. Connecting as read-only user '$READONLY_DB_USER'."

# Build a libpq conninfo string. The password is passed via PGPASSWORD (below) so
# it never appears in the connection string or the process argument list.
# `options` sets per-session server settings at connection time.
CONNINFO="host=$LOCAL_HOSTNAME port=$LOCAL_PORT dbname=$DB_NAME user=$READONLY_DB_USER sslmode=require application_name=claude-readonly options='-c default_transaction_read_only=on -c statement_timeout=30000'"

export PGPASSWORD="$READONLY_DB_PASSWORD"

if [ -n "$QUERY" ]; then
  # One-shot mode: run the query, print results, then the EXIT trap tears down the tunnel.
  psql "$CONNINFO" -v ON_ERROR_STOP=1 -P pager=off -c "$QUERY"
else
  # Interactive mode: drop into a psql shell. Quitting psql (\q) returns here and
  # the EXIT trap tears down the tunnel.
  echo "Opening interactive psql shell. Type \\q to quit and close the tunnel."
  psql "$CONNINFO"
fi
