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
    (cd "$SCRIPT_DIR/server/localdev" && docker compose stop fake-airtable fake-wordpress fake-quickbooks fake-moco fake-audienceful 2>/dev/null) || true

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

# Start fake connector APIs
echo -e "${MAGENTA}[FAKES]${NC} Starting fake connector APIs..."
(cd "$SCRIPT_DIR/server/localdev" && docker compose up -d --build fake-airtable fake-wordpress fake-quickbooks fake-moco fake-audienceful 2>&1) || {
    echo -e "${RED}Failed to start fake API containers${NC}"
    exit 1
}
echo -e "${GREEN}Fake connector APIs started${NC}"

# Wait for all fakes to be ready
echo -e "${MAGENTA}[FAKES]${NC} Waiting for fake APIs to be ready..."
for port in 4646 4647 4648 4649 4651; do
    for i in $(seq 1 30); do
        if curl -s -o /dev/null "http://localhost:$port/test/health" 2>/dev/null; then
            break
        fi
        sleep 1
    done
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

# Seed fake WordPress with starter data
echo -e "${MAGENTA}[FAKE-WORDPRESS]${NC} Seeding starter data..."
curl -s -X POST http://localhost:4647/test/setup -H 'Content-Type: application/json' -d '{
  "siteInfo": { "name": "Dev WordPress", "url": "http://localhost:4647" },
  "postTypes": [
    { "slug": "post", "name": "Posts", "rest_base": "posts", "rest_namespace": "wp/v2", "description": "", "hierarchical": false },
    { "slug": "page", "name": "Pages", "rest_base": "pages", "rest_namespace": "wp/v2", "description": "", "hierarchical": true }
  ],
  "taxonomies": [
    { "slug": "category", "name": "Categories", "rest_base": "categories", "rest_namespace": "wp/v2", "description": "", "hierarchical": true, "types": ["post"] },
    { "slug": "post_tag", "name": "Tags", "rest_base": "tags", "rest_namespace": "wp/v2", "description": "", "hierarchical": false, "types": ["post"] }
  ],
  "records": [
    {
      "tableId": "posts",
      "records": [
        { "title": { "rendered": "Hello World", "raw": "Hello World" }, "status": "publish", "content": { "rendered": "<p>Welcome!</p>", "raw": "Welcome!" } },
        { "title": { "rendered": "Draft Post", "raw": "Draft Post" }, "status": "draft", "content": { "rendered": "<p>WIP</p>", "raw": "WIP" } }
      ]
    },
    {
      "tableId": "pages",
      "records": [
        { "title": { "rendered": "About Us", "raw": "About Us" }, "status": "publish", "content": { "rendered": "<p>About page</p>", "raw": "About page" } }
      ]
    }
  ]
}' > /dev/null
echo -e "${GREEN}Fake WordPress seeded (2 post types, 2 taxonomies, 3 records)${NC}"

# Seed fake QuickBooks with starter data
echo -e "${MAGENTA}[FAKE-QUICKBOOKS]${NC} Seeding starter data..."
curl -s -X POST http://localhost:4648/test/setup -H 'Content-Type: application/json' -d '{
  "companyInfo": { "CompanyName": "Dev Company", "LegalName": "Dev Company LLC", "Country": "US" },
  "entities": [
    {
      "entityType": "Customer",
      "entities": [
        { "DisplayName": "Acme Corp", "PrimaryEmailAddr": { "Address": "acme@example.com" } },
        { "DisplayName": "Globex Inc", "PrimaryEmailAddr": { "Address": "globex@example.com" } }
      ]
    },
    {
      "entityType": "Invoice",
      "entities": [
        { "DocNumber": "1001", "TotalAmt": 500.00, "Balance": 500.00 },
        { "DocNumber": "1002", "TotalAmt": 1200.00, "Balance": 0 }
      ]
    }
  ]
}' > /dev/null
echo -e "${GREEN}Fake QuickBooks seeded (1 company, 2 customers, 2 invoices)${NC}"

# Seed fake Moco with starter data
echo -e "${MAGENTA}[FAKE-MOCO]${NC} Seeding starter data..."
curl -s -X POST http://localhost:4649/test/setup -H 'Content-Type: application/json' -d '{
  "companies": [
    { "name": "Acme Corp", "type": "customer", "website": "https://acme.example.com" },
    { "name": "Globex Inc", "type": "supplier", "website": "https://globex.example.com" }
  ],
  "contacts": [
    { "firstname": "Alice", "lastname": "Chen", "work_email": "alice@acme.example.com", "job_position": "CTO" },
    { "firstname": "Bob", "lastname": "Smith", "work_email": "bob@globex.example.com", "job_position": "PM" }
  ],
  "projects": [
    { "name": "Website Redesign", "active": true, "billable": true, "currency": "USD" }
  ]
}' > /dev/null
echo -e "${GREEN}Fake Moco seeded (2 companies, 2 contacts, 1 project)${NC}"

# Seed fake Audienceful with starter data
echo -e "${MAGENTA}[FAKE-AUDIENCEFUL]${NC} Seeding starter data..."
curl -s -X POST http://localhost:4651/test/setup -H 'Content-Type: application/json' -d '{
  "fields": [
    { "id": "fld001", "name": "First Name", "data_name": "first_name", "type": "string", "editable": true, "required": false },
    { "id": "fld002", "name": "Company", "data_name": "company", "type": "string", "editable": true, "required": false }
  ],
  "people": [
    { "email": "alice@example.com", "tags": [{ "name": "newsletter" }], "notes": "VIP subscriber", "first_name": "Alice", "company": "Acme" },
    { "email": "bob@example.com", "tags": [{ "name": "newsletter" }, { "name": "beta" }], "notes": "", "first_name": "Bob", "company": "Globex" }
  ]
}' > /dev/null
echo -e "${GREEN}Fake Audienceful seeded (2 fields, 2 people)${NC}"
echo ""

# Set URL overrides so the server redirects connector API calls to fakes
export API_URL_OVERRIDES="https://api.airtable.com=http://localhost:4646,https://test.wp.local=http://localhost:4647,https://quickbooks.api.intuit.com=http://localhost:4648,https://sandbox-quickbooks.api.intuit.com=http://localhost:4648,https://test.mocoapp.com=http://localhost:4649,https://app.audienceful.com=http://localhost:4651"

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
echo -e "  ${BLUE}Client${NC}:            http://localhost:3000"
echo -e "  ${GREEN}Server${NC}:            http://localhost:3010"
echo -e "  ${YELLOW}scratch-git-2${NC}:      http://localhost:3100 (API) + :3101 (HTTP backend)"
echo -e "  ${MAGENTA}Fake Airtable${NC}:     http://localhost:4646"
echo -e "  ${MAGENTA}Fake WordPress${NC}:    http://localhost:4647"
echo -e "  ${MAGENTA}Fake QuickBooks${NC}:   http://localhost:4648"
echo -e "  ${MAGENTA}Fake Moco${NC}:         http://localhost:4649"
echo -e "  ${MAGENTA}Fake Audienceful${NC}:  http://localhost:4651"
echo -e ""
echo -e "  ${MAGENTA}API overrides${NC}:  All connectors → localhost fakes"
echo -e "  ${YELLOW}Test domains${NC}:  WordPress=test.wp.local  Moco=test.mocoapp.com"
echo -e "${YELLOW}========================================${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo ""

# Wait for all background processes
wait
