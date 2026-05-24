#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.smoke-test.yml"
ENV_FILE="$SCRIPT_DIR/.env.integration"
EXAMPLE_FILE="$SCRIPT_DIR/.env.integration.example"

# Load env file
if [ ! -f "$ENV_FILE" ]; then
  echo "No .env.integration found."
  echo "Copy the example and fill in your Clerk secret key:"
  echo ""
  echo "  cp $EXAMPLE_FILE $ENV_FILE"
  echo ""
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

if [ -z "${CLERK_SECRET_KEY:-}" ] || [[ "$CLERK_SECRET_KEY" == *"<"* ]]; then
  echo "CLERK_SECRET_KEY is not set. Edit $ENV_FILE and add your key."
  exit 1
fi

# Start Docker stack
echo "Starting Docker stack..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up --build -d

echo "Waiting for services to be healthy..."
timeout=120
elapsed=0
while true; do
  unhealthy=$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --format json | grep -c '"Health":"starting"' || true)
  if [ "$unhealthy" -eq 0 ]; then
    break
  fi
  if [ "$elapsed" -ge "$timeout" ]; then
    echo "Timed out waiting for services. Check logs:"
    echo "  docker compose --env-file $ENV_FILE -f $COMPOSE_FILE logs"
    exit 1
  fi
  sleep 2
  elapsed=$((elapsed + 2))
done

echo "All services healthy."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

# Run tests
echo ""
echo "Running smoke tests..."
cd "$SCRIPT_DIR"

yarn test:smoke "$@"
