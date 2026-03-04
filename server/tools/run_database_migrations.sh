#!/bin/bash
set -e

if [ $# -ne 1 ]
then
  echo "You must provide the name of the environment as the first argument: 'eu-test' or 'eu-production'."
  exit 1
fi

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

echo "Starting SSH tunnel to GCP VM for $ENVIRONMENT: $DB_HOST"

LOCAL_HOSTNAME="127.0.0.1"
LOCAL_PORT=5433
REMOTE_PORT=5432

# URL-encode the password to handle special characters
ENCODED_PASSWORD=$(printf '%s' "$MIGRATIONS_DB_PASSWORD" | jq -sRr @uri)
DATABASE_URL="postgresql://${MIGRATIONS_DB_USER}:${ENCODED_PASSWORD}@${LOCAL_HOSTNAME}:${LOCAL_PORT}/${DB_NAME}"

CUSTOM_DOTENV_FILE="DATABASE_URL=\"${DATABASE_URL}\""
if [[ -f ".env" ]]; then
  mv .env .temp_running_a_script_env
fi
cat <<< "$CUSTOM_DOTENV_FILE" > .env


# Start the SSH tunnel.
echo "Starting SSH tunnel to gcp VM"
gcloud compute ssh cloudsql-proxy --project "${PROJECT}" --zone "${ZONE}" --tunnel-through-iap -- -N -L "$LOCAL_PORT:$DB_HOST:$REMOTE_PORT" &
# Remember the PID of the background process so we can kill it later.
ssh_tunnel_to_proxy_pid=$!

echo "SSH tunnel to GCP VM started"

# signal SSH tunnel when process exits
function cleanup {
  echo "Shutting down the SSH tunnel..."
  kill "$ssh_tunnel_to_proxy_pid"

  echo "Cleaning up env file..."
  rm .env

  # Put things back the way they were.
  if [[ -f ".temp_running_a_script_env" ]]; then
    mv .temp_running_a_script_env .env
  fi

  exit
}
trap cleanup EXIT

# Wait for port to be open
counter=0
sleep=5
timeout=600
while ! lsof -nP -iTCP:$LOCAL_PORT -s tcp:listen >/dev/null; do
  echo "Waiting for port $LOCAL_PORT to be open..."
  sleep $sleep
  counter=$((counter + sleep))
  if [ $counter -ge $timeout ]; then
    echo "Timeout after $timeout seconds. Port $LOCAL_PORT is still not open."
    echo "Failed to set up SSH tunnel to GCP VM!"
    exit 1
  fi
done

# Run the migration.
./node_modules/.bin/prisma migrate deploy
