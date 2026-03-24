#!/bin/bash
set -e


# Connects to the scratch-git GCE instance via IAP tunnel and forwards port 3100 locally
# Prerequisites:
#   - Install gcloud CLI and authenticate
# To use:
#   1. Run this script for the environment you want to access: 'test', 'staging', or 'production'
#      > ./connect_to_git_service.sh test
#   2. Access the git service at 127.0.0.1:3100
#   3. Ctrl-C the script or hit any key to terminate the tunnel

# arg1: environment: 'test'|'staging'|'production'

if [ $# -lt 1 ]
then
  echo "usage: $0 <environment>"
  echo "You must provide the name of the environment as the first argument: 'test', 'staging', or 'production'."
  exit 1
fi

# Ensure gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "gcloud could not be found, please install and authenticate."
    exit 1
fi

ENVIRONMENT=$1
GCP_PROJECT="spv1eu-${ENVIRONMENT}"

# Validate environment argument
if [[ "$ENVIRONMENT" != "test" && "$ENVIRONMENT" != "staging" && "$ENVIRONMENT" != "production" ]]; then
    echo "Error: Invalid environment '$ENVIRONMENT'"
    echo "Allowed values: 'test', 'staging', or 'production'"
    exit 1
fi

LOCAL_HOSTNAME="127.0.0.1"
LOCAL_PORT=3100
REMOTE_PORT=3100

# Start the SSH tunnel.
echo "Starting SSH tunnel to scratch-git VM for $ENVIRONMENT..."
gcloud compute ssh scratch-git --project "${GCP_PROJECT}" --zone europe-west1-b --tunnel-through-iap -- -N -L "$LOCAL_PORT:$LOCAL_HOSTNAME:$REMOTE_PORT" &
# Remember the PID of the background process so we can kill it later.
ssh_tunnel_pid=$!

# signal SSH tunnel when process exits
function cleanup {
  echo "Shutting down the SSH tunnel..."
  kill "$ssh_tunnel_pid"
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
    echo "Failed to set up SSH tunnel to scratch-git VM!"
    exit 1
  fi
done

echo "SSH tunnel started. Git service available at $LOCAL_HOSTNAME:$LOCAL_PORT"

echo "Press any key to terminate the tunnel..."

# Read a single character silently
read -rsn1
