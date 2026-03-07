#!/bin/bash

# Start all development servers for Spinner with fake connector APIs
# Usage: ./start-dev-v2-fakes.sh
#
# Same as start-dev-v2.sh but starts fake connector APIs via Docker
# and redirects connector API calls to them via API_URL_OVERRIDES.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
MAGENTA='\033[0;35m'
NC='\033[0m' # No Color

# Export colors so subshells can use them
export RED GREEN YELLOW BLUE MAGENTA NC

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

    # Wait a moment for graceful shutdown
    sleep 1

    # Force kill if still running
    [ -n "$CLIENT_PID" ] && kill -9 "$CLIENT_PID" 2>/dev/null || true
    [ -n "$SERVER_PID" ] && kill -9 "$SERVER_PID" 2>/dev/null || true
    [ -n "$SCRATCH_GIT_PID" ] && kill -9 "$SCRATCH_GIT_PID" 2>/dev/null || true

    # Stop fake API containers
    echo -e "${MAGENTA}Stopping fake API containers...${NC}"
    (cd "$SCRIPT_DIR/server/localdev" && docker compose stop fake-airtable 2>/dev/null) || true

    echo -e "${GREEN}All services stopped.${NC}"
    exit 0
}

trap cleanup SIGINT SIGTERM

echo -e "${YELLOW}========================================${NC}"
echo -e "${YELLOW}  Starting Spinner Development Servers${NC}"
echo -e "${YELLOW}  (with fake connector APIs)${NC}"
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

# Check if Docker services are running
if ! docker ps 2>/dev/null | grep -q postgres; then
    echo -e "${RED}Warning: PostgreSQL container doesn't appear to be running.${NC}"
    echo -e "${YELLOW}Start it with: cd server/localdev && docker compose up -d${NC}"
    echo ""
fi

# Start fake connector APIs
echo -e "${MAGENTA}[FAKE-AIRTABLE]${NC} Starting fake Airtable API on port 4646..."
(cd "$SCRIPT_DIR/server/localdev" && docker compose up -d --build fake-airtable 2>&1) || {
    echo -e "${RED}Failed to start fake Airtable container${NC}"
    exit 1
}
echo -e "${GREEN}Fake Airtable API started${NC}"

# Wait for fake Airtable to be ready
echo -e "${MAGENTA}[FAKE-AIRTABLE]${NC} Waiting for fake Airtable to be ready..."
for i in $(seq 1 30); do
    if curl -s -o /dev/null http://localhost:4646/test/reset -X POST 2>/dev/null; then
        break
    fi
    sleep 1
done

# Seed fake Airtable with starter data
echo -e "${MAGENTA}[FAKE-AIRTABLE]${NC} Seeding starter data..."
curl -s -X POST http://localhost:4646/test/setup -H 'Content-Type: application/json' -d '{
  "bases": [
    { "id": "appDEV001", "name": "Marketing", "permissionLevel": "create" },
    { "id": "appDEV002", "name": "Engineering", "permissionLevel": "create" }
  ],
  "tables": [
    {
      "baseId": "appDEV001",
      "tables": [
        {
          "id": "tblCampaigns",
          "name": "Campaigns",
          "primaryFieldId": "fldName",
          "fields": [
            { "id": "fldName", "name": "Name", "type": "singleLineText" },
            { "id": "fldStatus", "name": "Status", "type": "singleSelect" },
            { "id": "fldLaunchDate", "name": "Launch Date", "type": "date" },
            { "id": "fldBudget", "name": "Budget", "type": "currency" },
            { "id": "fldNotes", "name": "Notes", "type": "multilineText" }
          ],
          "views": [{ "id": "viwGrid", "name": "Grid view", "type": "grid" }]
        },
        {
          "id": "tblContacts",
          "name": "Contacts",
          "primaryFieldId": "fldFullName",
          "fields": [
            { "id": "fldFullName", "name": "Full Name", "type": "singleLineText" },
            { "id": "fldEmail", "name": "Email", "type": "email" },
            { "id": "fldCompany", "name": "Company", "type": "singleLineText" },
            { "id": "fldRole", "name": "Role", "type": "singleSelect" }
          ],
          "views": [{ "id": "viwGrid", "name": "Grid view", "type": "grid" }]
        }
      ]
    },
    {
      "baseId": "appDEV002",
      "tables": [
        {
          "id": "tblTasks",
          "name": "Tasks",
          "primaryFieldId": "fldTitle",
          "fields": [
            { "id": "fldTitle", "name": "Title", "type": "singleLineText" },
            { "id": "fldAssignee", "name": "Assignee", "type": "singleLineText" },
            { "id": "fldPriority", "name": "Priority", "type": "singleSelect" },
            { "id": "fldDone", "name": "Done", "type": "checkbox" },
            { "id": "fldDueDate", "name": "Due Date", "type": "date" }
          ],
          "views": [{ "id": "viwGrid", "name": "Grid view", "type": "grid" }]
        }
      ]
    }
  ],
  "records": [
    {
      "baseId": "appDEV001",
      "tableId": "tblCampaigns",
      "records": [
        { "fields": { "Name": "Spring Launch", "Status": "Active", "Budget": 5000, "Notes": "Q2 product launch campaign" } },
        { "fields": { "Name": "Newsletter Redesign", "Status": "Planning", "Budget": 1200, "Notes": "Update email templates" } },
        { "fields": { "Name": "Conference Booth", "Status": "Complete", "Budget": 8500, "Notes": "Annual industry conference" } }
      ]
    },
    {
      "baseId": "appDEV001",
      "tableId": "tblContacts",
      "records": [
        { "fields": { "Full Name": "Alice Chen", "Email": "alice@example.com", "Company": "Acme Corp", "Role": "Marketing" } },
        { "fields": { "Full Name": "Bob Smith", "Email": "bob@example.com", "Company": "Globex", "Role": "Engineering" } },
        { "fields": { "Full Name": "Carol Davis", "Email": "carol@example.com", "Company": "Initech", "Role": "Sales" } }
      ]
    },
    {
      "baseId": "appDEV002",
      "tableId": "tblTasks",
      "records": [
        { "fields": { "Title": "Fix login bug", "Assignee": "Bob", "Priority": "High", "Done": false } },
        { "fields": { "Title": "Update docs", "Assignee": "Alice", "Priority": "Medium", "Done": false } },
        { "fields": { "Title": "Deploy v2.1", "Assignee": "Carol", "Priority": "High", "Done": true } },
        { "fields": { "Title": "Write tests", "Assignee": "Bob", "Priority": "Low", "Done": false } }
      ]
    }
  ]
}' > /dev/null
echo -e "${GREEN}Fake Airtable seeded (2 bases, 3 tables, 10 records)${NC}"
echo ""

# Set URL overrides so the server redirects connector API calls to fakes
export API_URL_OVERRIDES="https://api.airtable.com=http://localhost:4646"

# Start Client (Next.js on port 3000)
echo -e "${BLUE}[CLIENT]${NC} Starting Next.js dev server on port 3000..."
(
    cd "$SCRIPT_DIR/client"
    # Prevent Next.js from clearing the terminal
    NEXT_PRIVATE_SKIP_TERMINAL_CLEAR=1 yarn run dev 2>&1 | while IFS= read -r line; do echo -e "${BLUE}[CLIENT]${NC} $line"; done
) &
CLIENT_PID=$!

# Start Server (NestJS on port 3010) with API_URL_OVERRIDES
echo -e "${GREEN}[SERVER]${NC} Starting NestJS dev server on port 3010 (with fake API overrides)..."
(
    cd "$SCRIPT_DIR/server"
    # Filter out ANSI clear screen sequences ([2J, [3J, [H) that TypeScript watch mode emits
    API_URL_OVERRIDES="$API_URL_OVERRIDES" yarn run start:dev 2>&1 | sed $'s/\033\\[2J//g; s/\033\\[3J//g; s/\033\\[H//g' | while IFS= read -r line; do echo -e "${GREEN}[SERVER]${NC} $line"; done
) &
SERVER_PID=$!

# Start scratch-git-2 API (Rust, port 3100)
echo -e "${YELLOW}[SCRATCH-GIT]${NC} Starting scratch-git-2 on port 3100..."
(
    cd "$SCRIPT_DIR/scratch-git-2"
    GIT_REPOS_DIR="$SCRIPT_DIR/local/scratch-git-repos" cargo run 2>&1 | while IFS= read -r line; do echo -e "${YELLOW}[SCRATCH-GIT]${NC} $line"; done
) &
SCRATCH_GIT_PID=$!

echo ""
echo -e "${YELLOW}========================================${NC}"
echo -e "  ${BLUE}Client${NC}:         http://localhost:3000"
echo -e "  ${GREEN}Server${NC}:         http://localhost:3010"
echo -e "  ${YELLOW}scratch-git-2${NC}:   http://localhost:3100 (API) + :3101 (HTTP backend)"
echo -e "  ${MAGENTA}Fake Airtable${NC}:  http://localhost:4646"
echo -e ""
echo -e "  ${MAGENTA}API overrides${NC}:  Airtable → localhost:4646"
echo -e "${YELLOW}========================================${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo ""

# Wait for all background processes
wait
