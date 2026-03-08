#!/usr/bin/env bash
# One-time setup for scratch-v3
# Run this after cloning the repo and checking out the experimental/scratch-v3 branch.
set -euo pipefail
cd "$(dirname "$0")"
V3_ROOT="$(pwd)"
REPO_ROOT="$(cd ../.. && pwd)"

echo "═══════════════════════════════════════════════════"
echo "  scratch-v3 setup"
echo "═══════════════════════════════════════════════════"

# ── 1. scratch-git-2 (git storage microservice) ──────────────
echo ""
echo "Step 1: Building scratch-git-2..."
cd "$REPO_ROOT/scratch-git-2"
cargo build 2>&1 | tail -3
echo "  ✓ scratch-git-2 built"

# ── 2. scratch-ui (FastAPI server) ────────────────────────────
echo ""
echo "Step 2: Setting up scratch-ui..."
cd "$V3_ROOT/scratch-ui"

if [ ! -d .venv ]; then
  echo "  Creating virtual environment..."
  python3 -m venv .venv
fi

source .venv/bin/activate
echo "  Installing Python dependencies..."
pip install -e . maturin --quiet 2>&1

if [ ! -f .env ]; then
  cp .env.example .env
  echo "  Created .env from template"
fi
echo "  ✓ scratch-ui ready"

# ── 3. scratch-engine (Rust engine + PyO3 Python module) ──────
echo ""
echo "Step 3: Building scratch-engine..."
cd "$V3_ROOT/scratch-engine"

echo "  Building CLI..."
cargo build -p scratch-cli 2>&1 | tail -3

echo "  Building Python module (maturin)..."
cd crates/scratch-engine-py
VIRTUAL_ENV="$V3_ROOT/scratch-ui/.venv" \
  "$V3_ROOT/scratch-ui/.venv/bin/maturin" develop --release 2>&1 | tail -3
echo "  ✓ scratch-engine built"

# ── 4. Check scenario .env ────────────────────────────────────
echo ""
if [ ! -f "$V3_ROOT/scratch-scenarios/.env" ]; then
  echo "Step 4: ⚠  No scratch-scenarios/.env found"
  echo "  Copy it from a teammate or create one — see scratch-scenarios/.env.example"
else
  echo "Step 4: ✓ scratch-scenarios/.env exists"
fi

echo ""
echo "═══════════════════════════════════════════════════"
echo "  Setup complete!"
echo ""
echo "  Next: ./start.sh   (starts all servers)"
echo "═══════════════════════════════════════════════════"
