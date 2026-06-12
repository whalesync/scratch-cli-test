#!/bin/bash
set -e

if [ $# -ne 1 ]
then
  echo "You must provide the name of the environment as the first argument: 'test' or 'production'."
  exit 1
fi

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

# Validate environment argument
if [[ "$ENVIRONMENT" != "test" && "$ENVIRONMENT" != "production" ]]; then
    echo "Error: Invalid environment '$ENVIRONMENT'"
    echo "Allowed values: 'test' or 'production'"
    exit 1
fi

PROJECT="spv1eu-${ENVIRONMENT}"
MIGRATIONS_DB_USER=$(gcloud secrets versions access latest --project="${PROJECT}" --secret=MIGRATIONS_DB_USER)
MIGRATIONS_DB_PASSWORD=$(gcloud secrets versions access latest --project="${PROJECT}" --secret=MIGRATIONS_DB_PASSWORD)
DB_NAME=postgres

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

LOCAL_HOSTNAME="127.0.0.1"
LOCAL_PORT=5433

# URL-encode the password to handle special characters
ENCODED_PASSWORD=$(printf '%s' "$MIGRATIONS_DB_PASSWORD" | jq -sRr @uri)
DATABASE_URL="postgresql://${MIGRATIONS_DB_USER}:${ENCODED_PASSWORD}@${LOCAL_HOSTNAME}:${LOCAL_PORT}/${DB_NAME}"

echo "${DATABASE_URL}"