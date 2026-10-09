#!/bin/bash
set -e

if [ $# -ne 1 ]
then
  echo "You must provide the name of the environment as the first argument: 'eu-test' or 'eu-production'."
  exit 1
fi

# Sets LOCAL_HOSTNAME/LOCAL_PORT and provides open_gcp_db_tunnel, so this run's tunnel never
# shares a port with a Whalesync tunnel (DEV-11794). Sourced before the cd below, while $0
# still resolves from the caller's directory.
# shellcheck source-path=SCRIPTDIR source=../../terraform/tools/lib/gcp_db_tunnel.sh
source "$(dirname "$0")/../../terraform/tools/lib/gcp_db_tunnel.sh"

# Change to server directory
cd "$(dirname "$0")/../"

# Ensure gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "gcloud could not be found, please install and authenticate."
    exit 1
fi

# Check for GCP project configuration in gcloud
if ! gcloud config get-value project &> /dev/null; then
    echo "GCP project not set, please configure gcloud."
    exit 1
fi

# Ensure jq is installed
if ! command -v jq &> /dev/null; then
    echo "jq could not be found, please install jq for URL encoding."
    exit 1
fi

ENVIRONMENT=$1

# Validate environment argument and set project/zone
case "$ENVIRONMENT" in
    "eu-test")
        PROJECT="spv1eu-test"
        ZONE="europe-west1-b"
        DB_NAME="scratchpad"
        ;;
    "eu-production")
        PROJECT="spv1eu-production"
        ZONE="europe-west1-b"
        DB_NAME="scratchpad"
        ;;
    *)
        echo "Error: Invalid environment '$ENVIRONMENT'"
        echo "Allowed values: 'eu-test' or 'eu-production'"
        exit 1
        ;;
esac
MIGRATIONS_DB_USER=$(gcloud secrets versions access latest --project="${PROJECT}" --secret=MIGRATIONS_DB_USER)
MIGRATIONS_DB_PASSWORD=$(gcloud secrets versions access latest --project="${PROJECT}" --secret=MIGRATIONS_DB_PASSWORD)
# Default DB_NAME if not set by environment-specific case
DB_NAME=${DB_NAME:-postgres}

# Override the DB_HOST if provided as a second argument
if [ $# -ge 2 ]; then
    DB_HOST=$2
else
  DB_HOST=$(gcloud sql instances list \
      --project="${PROJECT}" \
      --filter="labels.primary=true" \
      --format="value(ipAddresses[0].ipAddress)" \
      --limit=1)
  if [ -z "$DB_HOST" ]; then
    echo "Error: failed to find IP for database instance"
    exit 1
  fi
fi

# Set once this run has swapped its own .env in, so cleanup only removes a .env it wrote.
replaced_dotenv_with_migrations_database_url=false

# signal SSH tunnel when process exits
function cleanup {
  echo "Shutting down the SSH tunnel..."
  kill "$ssh_tunnel_to_proxy_pid" 2>/dev/null || true

  if [ "$replaced_dotenv_with_migrations_database_url" = true ]; then
    echo "Cleaning up env file..."
    rm -f .env

    # Put things back the way they were.
    if [[ -f ".temp_running_a_script_env" ]]; then
      mv .temp_running_a_script_env .env
    fi
  fi

  exit
}
trap cleanup EXIT

# Start the SSH tunnel.
open_gcp_db_tunnel "${PROJECT}" "${ZONE}" "$DB_HOST"
echo "SSH tunnel to GCP VM started on local port $LOCAL_PORT"

# The URL needs the tunnel's local port, so .env is written only once the tunnel is up.
# URL-encode the password to handle special characters
ENCODED_PASSWORD=$(printf '%s' "$MIGRATIONS_DB_PASSWORD" | jq -sRr @uri)
DATABASE_URL="postgresql://${MIGRATIONS_DB_USER}:${ENCODED_PASSWORD}@${LOCAL_HOSTNAME}:${LOCAL_PORT}/${DB_NAME}"

CUSTOM_DOTENV_FILE="DATABASE_URL=\"${DATABASE_URL}\""
if [[ -f ".env" ]]; then
  mv .env .temp_running_a_script_env
fi
replaced_dotenv_with_migrations_database_url=true
cat <<< "$CUSTOM_DOTENV_FILE" > .env

# Run the migration.
./node_modules/.bin/prisma migrate deploy
