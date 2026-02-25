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

# Install scratch-git dependencies
echo -e "${YELLOW}Installing scratch-git dependencies...${NC}"
(
    cd "$SCRIPT_DIR/scratch-git"
    yarn install --silent
) || {
    echo -e "${RED}Failed to install scratch-git dependencies${NC}"
    exit 1
}
echo -e "${GREEN}scratch-git dependencies installed${NC}"
echo ""

# PIDs for cleanup
CLIENT_PID=""
SERVER_PID=""
SCRATCH_GIT_PID=""
SCRATCH_GIT_HTTP_PID=""

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

    if [ -n "$SCRATCH_GIT_HTTP_PID" ] && kill -0 "$SCRATCH_GIT_HTTP_PID" 2>/dev/null; then
        echo -e "${YELLOW}Stopping scratch-git HTTP backend...${NC}"
        kill "$SCRATCH_GIT_HTTP_PID" 2>/dev/null || true
    fi

    # Wait a moment for graceful shutdown
    sleep 1

    # Force kill if still running
    [ -n "$CLIENT_PID" ] && kill -9 "$CLIENT_PID" 2>/dev/null || true
    [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null || true
    [ -n "$SCRATCH_GIT_PID" ] && kill -9 "$SCRATCH_GIT_PID" 2>/dev/null || true
    [ -n "$SCRATCH_GIT_HTTP_PID" ] && kill -9 "$SCRATCH_GIT_HTTP_PID" 2>/dev/null || true

    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}  Starting Spinner Development Servers${NC}"
echo -e "${YELLOW}========================================${NC}"
echo ""

# Check if Docker services are running
if ! docker ps 2>/dev/null | grep -q postgres; then
    echo -e "${RED}Warning: PostgreSQL container doesn't appear to be running.${NC}"
    echo -e "${YELLOW}Start it with: cd server/localdev && docker compose up -d${NC}"
    echo ""
fi

# Start Client (Next.js on port 3000)
echo -e "${BLUE}[CLIENT]${NC} Starting Next.js dev server on port 3000..."
(
    cd "$SCRIPT_DIR/client"
    # Prevent Next.js from clearing the terminal
    NEXT_PRIVATE_SKIP_TERMINAL_CLEAR=1 yarn run dev 2>&1 | while IFS= read -r line; do echo -e "${BLUE}[CLIENT]${NC} $line"; done
) &
CLIENT_PID=$!

# Start Server (NestJS on port 3010)
echo -e "${GREEN}[SERVER]${NC} Starting NestJS dev server on port 3010..."
(
    cd "$SCRIPT_DIR/server"
    # Filter out ANSI clear screen sequences ([2J, [3J, [H) that TypeScript watch mode emits
    yarn run start:dev 2>&1 | sed $'s/\033\\[2J//g; s/\033\\[3J//g; s/\033\\[H//g' | while IFS= read -r line; do echo -e "${GREEN}[SERVER]${NC} $line"; done
) &
SERVER_PID=$!

# Start scratch-git API (port 3100)
echo -e "${YELLOW}[SCRATCH-GIT]${NC} Starting Git API on port 3100..."
(
    cd "$SCRIPT_DIR/scratch-git"
    yarn run start:api 2>&1 | while IFS= read -r line; do echo -e "${YELLOW}[SCRATCH-GIT]${NC} $line"; done
) &
SCRATCH_GIT_PID=$!

# Start scratch-git HTTP backend (port 3101)
echo -e "${YELLOW}[SCRATCH-GIT-HTTP]${NC} Starting Git HTTP backend on port 3101..."
(
    cd "$SCRIPT_DIR/scratch-git"
    yarn run dev:http-backend 2>&1 | while IFS= read -r line; do echo -e "${YELLOW}[SCRATCH-GIT-HTTP]${NC} $line"; done
) &
SCRATCH_GIT_HTTP_PID=$!

echo ""
echo -e "${YELLOW}========================================${NC}"
echo -e "  ${BLUE}Client${NC}:       http://localhost:3000"
echo -e "  ${GREEN}Server${NC}:       http://localhost:3010"
echo -e "  ${YELLOW}scratch-git${NC}:  http://localhost:3100 (API), http://localhost:3101 (HTTP backend)"
echo -e "${YELLOW}========================================${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo ""

# Wait for all background processes
wait
