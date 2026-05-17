#!/bin/bash

# Start all development servers for Spinner
# Usage: ./start-dev.sh

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Export colors so subshells can use them
export RED GREEN YELLOW BLUE NC

# Setup nvm and node
export NVM_DIR="$HOME/.nvm"
if [ -s "$NVM_DIR/nvm.sh" ]; then
    # Source nvm without auto-use
    \. "$NVM_DIR/nvm.sh" --no-use
    # Use node 22
    nvm use 22 > /dev/null 2>&1 || nvm use node > /dev/null 2>&1 || true
fi

# Verify node is available
if ! command -v node &> /dev/null; then
    echo -e "${RED}Error: Node.js is not available. Please install Node.js 22+${NC}"
    exit 1
fi

# Verify cargo (Rust) is available
if ! command -v cargo &> /dev/null; then
    echo -e "${YELLOW}Rust/Cargo not found. Installing via Homebrew...${NC}"
    brew install rust || {
        echo -e "${RED}Failed to install Rust. Please install manually: https://rustup.rs${NC}"
        exit 1
    }
fi

echo -e "${YELLOW}Using Node $(node --version)${NC}"

# Build shared-types package first
echo -e "${YELLOW}Building shared-types package...${NC}"
(
    cd "$SCRIPT_DIR/packages/shared-types"
    yarn install --silent 2>/dev/null
    yarn build
) || {
    echo -e "${RED}Failed to build shared-types package${NC}"
    exit 1
}
echo -e "${GREEN}shared-types built successfully${NC}"
echo ""

# Ensure Docker infrastructure services are running
echo -e "${YELLOW}Checking Docker infrastructure services...${NC}"
(cd "$SCRIPT_DIR/server/localdev" && docker compose up -d db redis mongodb 2>&1) || {
    echo -e "${RED}Failed to start Docker services. Is Docker running?${NC}"
    exit 1
}
# Wait for PostgreSQL to be ready to accept connections
echo -ne "${YELLOW}Waiting for PostgreSQL to be ready...${NC}"
for i in $(seq 1 30); do
    if docker exec localdev-db-1 pg_isready -U postgres > /dev/null 2>&1; then
        break
    fi
    echo -n "."
    sleep 1
done
echo ""
if ! docker exec localdev-db-1 pg_isready -U postgres > /dev/null 2>&1; then
    echo -e "${RED}PostgreSQL failed to become ready within 30 seconds${NC}"
    exit 1
fi
echo -e "${GREEN}Docker infrastructure services are running${NC}"
echo ""

# Install server dependencies and run migrations
echo -e "${YELLOW}Installing server dependencies...${NC}"
(
    cd "$SCRIPT_DIR/server"
    yarn install --silent
) || {
    echo -e "${RED}Failed to install server dependencies${NC}"
    exit 1
}
echo -e "${GREEN}Server dependencies installed${NC}"

echo -e "${YELLOW}Cleaning and rebuilding server...${NC}"
(
    cd "$SCRIPT_DIR/server"
    rm -rf dist
    yarn build
) || {
    echo -e "${RED}Failed to build server${NC}"
    exit 1
}
echo -e "${GREEN}Server build complete${NC}"

echo -e "${YELLOW}Running Prisma migrations...${NC}"
(
    cd "$SCRIPT_DIR/server"
    yarn run migrate
) || {
    echo -e "${RED}Failed to run Prisma migrations${NC}"
    exit 1
}
echo -e "${GREEN}Prisma migrations complete${NC}"
echo ""

# Install client dependencies
echo -e "${YELLOW}Installing client dependencies...${NC}"
(
    cd "$SCRIPT_DIR/client"
    yarn install --silent
) || {
    echo -e "${RED}Failed to install client dependencies${NC}"
    exit 1
}
echo -e "${GREEN}Client dependencies installed${NC}"
echo ""

# Install scratch-desktop dependencies (runs electron-builder install-app-deps via postinstall)
echo -e "${YELLOW}Installing scratch-desktop dependencies...${NC}"
(
    cd "$SCRIPT_DIR/scratch-desktop"
    yarn install --silent
) || {
    echo -e "${RED}Failed to install scratch-desktop dependencies${NC}"
    exit 1
}
echo -e "${GREEN}scratch-desktop dependencies installed${NC}"
echo ""

# Build scratch-git-2 (Rust)
echo -e "${YELLOW}Building scratch-git-2...${NC}"
(
    cd "$SCRIPT_DIR/scratch-git-2"
    cargo build 2>&1
) || {
    echo -e "${RED}Failed to build scratch-git-2${NC}"
    exit 1
}
echo -e "${GREEN}scratch-git-2 built successfully${NC}"
echo ""

# PIDs for cleanup
CLIENT_PID=""
SERVER_PID=""
SCRATCH_GIT_PID=""
DESKTOP_PID=""
cleanup() {
    echo -e "\n${YELLOW}Shutting down all services...${NC}"

    if [ -n "$CLIENT_PID" ] && kill -0 "$CLIENT_PID" 2>/dev/null; then
        echo -e "${BLUE}Stopping client...${NC}"
        kill "$CLIENT_PID" 2>/dev/null || true
    fi

    if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
        echo -e "${GREEN}Stopping server...${NC}"
        kill "$SERVER_PID" 2>/dev/null || true
    fi

    if [ -n "$SCRATCH_GIT_PID" ] && kill -0 "$SCRATCH_GIT_PID" 2>/dev/null; then
        echo -e "${YELLOW}Stopping scratch-git API...${NC}"
        kill "$SCRATCH_GIT_PID" 2>/dev/null || true
    fi

    if [ -n "$DESKTOP_PID" ] && kill -0 "$DESKTOP_PID" 2>/dev/null; then
        echo -e "${BLUE}Stopping scratch-desktop...${NC}"
        kill "$DESKTOP_PID" 2>/dev/null || true
    fi

    # Wait a moment for graceful shutdown
    sleep 1

    # Force kill if still running
    [ -n "$CLIENT_PID" ] && kill -9 "$CLIENT_PID" 2>/dev/null || true
    [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null || true
    [ -n "$SCRATCH_GIT_PID" ] && kill -9 "$SCRATCH_GIT_PID" 2>/dev/null || true
    [ -n "$DESKTOP_PID" ] && kill -9 "$DESKTOP_PID" 2>/dev/null || true

    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}  Starting Spinner Development Servers${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""

# Auto-migrate old git repos to the git-ignored local folder
if [ -d "$SCRIPT_DIR/scratch-git/repos" ]; then
    echo -e "${YELLOW}Migrating old git repositories to new local directory...${NC}"
    mkdir -p "$SCRIPT_DIR/local/scratch-git-repos"
    mv "$SCRIPT_DIR/scratch-git/repos/"* "$SCRIPT_DIR/local/scratch-git-repos/" 2>/dev/null || true
    rm -rf "$SCRIPT_DIR/scratch-git/repos"
    echo -e "${GREEN}Migration complete.${NC}"
    echo ""
fi

# Log files — raw (uncolorized) output for easy grepping
CLIENT_LOG="/tmp/scratch-client.log"
SERVER_LOG="/tmp/scratch-server.log"
SCRATCH_GIT_LOG="/tmp/scratch-git.log"
DESKTOP_LOG="/tmp/scratch-desktop.log"

# Start Client (Next.js on port 3000)
echo -e "${BLUE}[CLIENT]${NC} Starting Next.js dev server on port 3000..."
(
    cd "$SCRIPT_DIR/client"
    # Prevent Next.js from clearing the terminal
    NEXT_PRIVATE_SKIP_TERMINAL_CLEAR=1 yarn run dev 2>&1 | tee "$CLIENT_LOG" | while IFS= read -r line; do echo -e "${BLUE}[CLIENT]${NC} $line"; done
) &
CLIENT_PID=$!

# Start Server (NestJS on port 3010)
echo -e "${GREEN}[SERVER]${NC} Starting NestJS dev server on port 3010..."
(
    cd "$SCRIPT_DIR/server"
    # Filter out ANSI clear screen sequences ([2J, [3J, [H) that TypeScript watch mode emits
    # Load server/.env into the environment so all vars are available to the process
    set -a; source .env 2>/dev/null; set +a
    # stdbuf -oL forces line-buffered output so tee and sed flush each line immediately
    yarn run start:dev 2>&1 | stdbuf -oL sed $'s/\033\\[2J//g; s/\033\\[3J//g; s/\033\\[H//g' | stdbuf -oL tee "$SERVER_LOG" | while IFS= read -r line; do echo -e "${GREEN}[SERVER]${NC} $line"; done
) &
SERVER_PID=$!

# Start scratch-git-2 API (Rust, port 3100)
echo -e "${YELLOW}[SCRATCH-GIT]${NC} Starting scratch-git-2 on port 3100..."
(
    cd "$SCRIPT_DIR/scratch-git-2"
    GIT_REPOS_DIR="$SCRIPT_DIR/local/scratch-git-repos" cargo run 2>&1 | tee "$SCRATCH_GIT_LOG" | while IFS= read -r line; do echo -e "${YELLOW}[SCRATCH-GIT]${NC} $line"; done
) &
SCRATCH_GIT_PID=$!

# Wait for client to be ready before launching the Electron desktop app,
# so it doesn't open against a dead http://localhost:3000.
(
    echo -e "${BLUE}[DESKTOP]${NC} Waiting for client on port 3000..."
    for i in $(seq 1 120); do
        if curl -sf -o /dev/null "http://localhost:3000"; then
            echo -e "${BLUE}[DESKTOP]${NC} Client is up. Starting Electron..."
            cd "$SCRIPT_DIR/scratch-desktop"
            yarn dev 2>&1 | tee "$DESKTOP_LOG" | while IFS= read -r line; do echo -e "${BLUE}[DESKTOP]${NC} $line"; done
            exit 0
        fi
        sleep 1
    done
    echo -e "${RED}[DESKTOP]${NC} Client never came up on port 3000; skipping desktop app."
) &
DESKTOP_PID=$!

echo ""
echo -e "${YELLOW}========================================${NC}"
echo -e "  ${BLUE}Client${NC}:       http://localhost:3000"
echo -e "  ${GREEN}Server${NC}:       http://localhost:3010"
echo -e "  ${YELLOW}scratch-git-2${NC}: http://localhost:3100 (API) + :3101 (HTTP backend)"
echo -e "  ${BLUE}Desktop${NC}:      Electron app (launches after client is ready)"
echo -e "${YELLOW}========================================${NC}"
echo ""
echo -e "  Logs: ${BLUE}$CLIENT_LOG${NC}"
echo -e "        ${GREEN}$SERVER_LOG${NC}"
echo -e "        ${YELLOW}$SCRATCH_GIT_LOG${NC}"
echo -e "        ${BLUE}$DESKTOP_LOG${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo ""

# Wait for all background processes
wait
