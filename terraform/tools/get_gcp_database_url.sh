#!/bin/bash
set -e

# Prints a database URL for the tunnel connect_to_gcp_db.sh opened.
# arg1: environment: 'test'|'production'
# arg2 (optional): the local port connect_to_gcp_db.sh printed. Defaults to the first port
#                  in Scratch's tunnel range, 5533.

# Sets LOCAL_HOSTNAME and FIRST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT (DEV-11794).
# shellcheck source-path=SCRIPTDIR source=lib/gcp_db_tunnel.sh
source "$(dirname "$0")/lib/gcp_db_tunnel.sh"

if [ $# -lt 1 ] || [ $# -gt 2 ]
then
  echo "usage: $0 <environment> [local_port]"
  echo "You must provide the name of the environment as the first argument: 'test' or 'production'."
  echo "Optionally provide the local port connect_to_gcp_db.sh printed (default $FIRST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT)."
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

LOCAL_PORT=${2:-$FIRST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT}
if ! [[ "$LOCAL_PORT" =~ ^[0-9]+$ ]]; then
  echo "Error: the local port must be a number, got: '$LOCAL_PORT'"
  exit 1
fi

PROJECT="spv1eu-${ENVIRONMENT}"
MIGRATIONS_DB_USER=$(gcloud secrets versions access latest --project="${PROJECT}" --secret=MIGRATIONS_DB_USER)
MIGRATIONS_DB_PASSWORD=$(gcloud secrets versions access latest --project="${PROJECT}" --secret=MIGRATIONS_DB_PASSWORD)
DB_NAME=postgres

# URL-encode the password to handle special characters
ENCODED_PASSWORD=$(printf '%s' "$MIGRATIONS_DB_PASSWORD" | jq -sRr @uri)
DATABASE_URL="postgresql://${MIGRATIONS_DB_USER}:${ENCODED_PASSWORD}@${LOCAL_HOSTNAME}:${LOCAL_PORT}/${DB_NAME}"

echo "${DATABASE_URL}"