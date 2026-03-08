#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "Creating virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate

echo "Installing dependencies..."
pip install -e . --quiet

if [ ! -f .env ]; then
  cp .env.example .env
  echo "Created .env from .env.example — edit it to set SCRATCH_API_URL and SCRATCH_API_TOKEN"
fi

echo "Starting scratch-ui on http://localhost:8000"
exec uvicorn app.main:app --port 8000 --reload
