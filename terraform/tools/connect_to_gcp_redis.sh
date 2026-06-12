#!/bin/bash
set -e

# Connects to the proxy host for the GCP VPC network of a given environment and sets up a proxy port for the Redis Memstore
# in that environment
# Prerequisites:
#   - Install gcloud CLI and authenticate
# To use:
#   1. Run this script for the environment you want to access: 'test' or 'production'
#      > ./connect_to_gcp_redis.sh test
#   2. Use Redis CLI to connect to the Redis instance at 127.0.0.1:6399 
#          redis-cli -h 127.0.0.1 -p 6399 -a <REDIS_PASS>
#      Get the password from the GCP Secrets Manager
#   3. Ctrl-C the script or hit any key to terminate the tunnel

# arg1: environment: 'test'|'production'

if [ $# -lt 1 ]
then
  echo "usage: $0 <environment> [host]"
  echo "You must provide the name of the environment as the first argument: 'test' or 'production'."
  exit 1
fi

# Ensure gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "gcloud could not be found, please install and authenticate."
    exit 1
fi

ENVIRONMENT=$1
GCP_PROJECT="spv1eu-${ENVIRONMENT}"
GCP_REGION=europe-west1

# Validate environment argument
if [[ "$ENVIRONMENT" != "test" && "$ENVIRONMENT" != "production" ]]; then
    echo "Error: Invalid environment '$ENVIRONMENT'"
    echo "Allowed values: 'test' or 'production'"
    exit 1
fi

# Override the REDIS_HOST if provided as a second argument
# Override the REDIS_HOST if provided as a second argument
if [ $# -ge 2 ]; then
    REDIS_HOST=$2
else
  REDIS_HOST=$(gcloud redis instances list \
      --project="${GCP_PROJECT}" \
      --region="${GCP_REGION}" \
      --filter="labels.primary=true" \
      --format="value(host)" \
      --limit=1)
  if [ -z "$REDIS_HOST" ]; then
    echo "Error: failed to find IP for Redis instance with label env=${ENVIRONMENT}"
    exit 1
  fi
fi

LOCAL_HOSTNAME="127.0.0.1"
LOCAL_PORT=6399
REMOTE_PORT=6379

# Start the SSH tunnel.
echo "Starting SSH tunnel to gcp VM for $ENVIRONMENT: $REDIS_HOST"
gcloud compute ssh cloudsql-proxy --project "${GCP_PROJECT}" --zone "europe-west1-b" --tunnel-through-iap -- -N -L "$LOCAL_PORT:$REDIS_HOST:$REMOTE_PORT" &
# Remember the PID of the background process so we can kill it later.
ssh_tunnel_to_proxy_pid=$!

# signal SSH tunnel when process exits
function cleanup {
  echo "Shutting down the SSH tunnel..."
  kill "$ssh_tunnel_to_proxy_pid"
  exit
}
trap cleanup EXIT

# Wait for port to be open
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

echo "SSH tunnel to GCP VM started. Use your Redis CLI or other client to connect to $LOCAL_HOSTNAME:$LOCAL_PORT":
echo "redis-cli -h 127.0.0.1 -p 6399 -a <password>"
echo
echo "You can get the password with gcloud using:"
echo "gcloud redis instances get-auth-string --project \"${GCP_PROJECT}\" --region \"${GCP_REGION}\" ${ENVIRONMENT}-redis --format='value(authString)'"
echo
echo "Press any key to terminate the tunnel..."

# Read a single character silently
read -rsn1
