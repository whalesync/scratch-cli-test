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
    (cd "$SCRIPT_DIR/server/localdev" && docker compose stop fake-airtable fake-wordpress fake-quickbooks fake-moco fake-audienceful fake-memberstack fake-hubspot fake-affinity 2>/dev/null) || true

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
(cd "$SCRIPT_DIR/server/localdev" && docker compose up -d --build fake-airtable fake-wordpress fake-quickbooks fake-moco fake-audienceful fake-memberstack fake-hubspot fake-affinity 2>&1) || {
    echo -e "${RED}Failed to start fake API containers${NC}"
    exit 1
}
echo -e "${GREEN}Fake connector APIs started${NC}"

# Wait for all fakes to be ready
echo -e "${MAGENTA}[FAKES]${NC} Waiting for fake APIs to be ready..."
for port in 4646 4647 4648 4649 4651 4652 4653 4654; do
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

# Seed fake Memberstack with starter data
echo -e "${MAGENTA}[FAKE-MEMBERSTACK]${NC} Seeding starter data..."
curl -s -X POST http://localhost:4652/test/setup -H 'Content-Type: application/json' -d '{
  "members": [
    {
      "id": "mem_dev001",
      "auth": { "email": "alice@example.com" },
      "customFields": { "first_name": "Alice", "company": "Acme Corp" },
      "metaData": { "source": "website" },
      "json": {},
      "planConnections": [{ "id": "plnc_001", "active": true, "status": "active", "planId": "pln_free", "planName": "Free Plan", "type": "free", "payment": null }],
      "loginRedirect": "/dashboard",
      "permissions": ["member"],
      "verified": true,
      "createdAt": "2025-01-15T10:00:00Z"
    },
    {
      "id": "mem_dev002",
      "auth": { "email": "bob@example.com" },
      "customFields": { "first_name": "Bob", "company": "Globex Inc" },
      "metaData": { "source": "invite" },
      "json": { "preferences": { "theme": "dark" } },
      "planConnections": [{ "id": "plnc_002", "active": true, "status": "active", "planId": "pln_pro", "planName": "Pro Plan", "type": "free", "payment": null }],
      "loginRedirect": "/dashboard",
      "permissions": ["member", "admin"],
      "verified": true,
      "createdAt": "2025-02-20T14:30:00Z"
    },
    {
      "id": "mem_dev003",
      "auth": { "email": "carol@example.com" },
      "customFields": { "first_name": "Carol" },
      "metaData": {},
      "json": {},
      "planConnections": [],
      "loginRedirect": "",
      "permissions": [],
      "verified": false,
      "createdAt": "2025-03-10T09:15:00Z"
    }
  ]
}' > /dev/null
echo -e "${GREEN}Fake Memberstack seeded (3 members)${NC}"

# Seed fake HubSpot with starter data
echo -e "${MAGENTA}[FAKE-HUBSPOT]${NC} Seeding starter data..."
curl -s -X POST http://localhost:4653/test/setup -H 'Content-Type: application/json' -d '{
  "objectTypes": [
    {
      "objectType": "contacts",
      "records": [
        { "properties": { "email": "alice@example.com", "firstname": "Alice", "lastname": "Chen", "company": "Acme Corp" } },
        { "properties": { "email": "bob@example.com", "firstname": "Bob", "lastname": "Smith", "company": "Globex Inc" } },
        { "properties": { "email": "carol@example.com", "firstname": "Carol", "lastname": "Davis", "company": "Initech" } }
      ]
    },
    {
      "objectType": "companies",
      "records": [
        { "properties": { "name": "Acme Corp", "domain": "acme.example.com" } },
        { "properties": { "name": "Globex Inc", "domain": "globex.example.com" } }
      ]
    },
    {
      "objectType": "deals",
      "records": [
        { "properties": { "dealname": "Big Deal", "amount": "50000", "dealstage": "qualifiedtobuy" } },
        { "properties": { "dealname": "Small Deal", "amount": "5000", "dealstage": "appointmentscheduled" } }
      ]
    }
  ]
}' > /dev/null
echo -e "${GREEN}Fake HubSpot seeded (3 contacts, 2 companies, 2 deals)${NC}"

# Seed fake Affinity with starter data — 3 lists (one per entity type),
# with realistic field metadata and a few entries each. Designed to exercise:
#   - All three entity types (company / person / opportunity)
#   - Multiple field type categories (list / enriched / global)
#   - A non-trivial valueType (dropdown) so the schema builder is exercised
#   - The array→keyed-object transform on real-shaped fields
echo -e "${MAGENTA}[FAKE-AFFINITY]${NC} Seeding starter data..."
curl -s -X POST http://localhost:4654/test/setup -H 'Content-Type: application/json' -d '{
  "lists": [
    { "id": 1001, "name": "Companies (Pipeline)", "type": "company", "ownerId": 1, "creatorId": 1 },
    { "id": 1002, "name": "People (Network)",     "type": "person",  "ownerId": 1, "creatorId": 1 },
    { "id": 1003, "name": "Deals",                "type": "opportunity", "ownerId": 1, "creatorId": 1 }
  ],
  "fieldsByList": {
    "1001": [
      { "id": "field-1001-stage",     "name": "Stage",     "type": "list",     "valueType": "dropdown",       "enrichmentSource": null },
      { "id": "field-1001-owner",     "name": "Owner",     "type": "list",     "valueType": "person",         "enrichmentSource": null },
      { "id": "affinity-data-location","name": "Location", "type": "enriched", "valueType": "location",       "enrichmentSource": "affinity-data" }
    ],
    "1002": [
      { "id": "field-1002-role",      "name": "Role",      "type": "list",     "valueType": "filterable-text","enrichmentSource": null },
      { "id": "field-1002-priority",  "name": "Priority",  "type": "list",     "valueType": "dropdown",       "enrichmentSource": null }
    ],
    "1003": [
      { "id": "field-1003-amount",    "name": "Amount",    "type": "list",     "valueType": "number",         "enrichmentSource": null },
      { "id": "field-1003-stage",     "name": "Stage",     "type": "list",     "valueType": "dropdown",       "enrichmentSource": null }
    ]
  },
  "entriesByList": {
    "1001": [
      {
        "id": 5001, "type": "company", "listId": 1001, "createdAt": "2025-01-15T10:00:00Z", "creatorId": 1,
        "entity": {
          "id": 7001, "name": "Acme Corp", "domain": "acme.example.com", "domains": ["acme.example.com"], "isGlobal": true,
          "fields": [
            { "id": "field-1001-stage", "name": "Stage", "type": "list", "enrichmentSource": null, "value": { "type": "dropdown", "data": { "id": 1, "text": "Active" } } },
            { "id": "affinity-data-location", "name": "Location", "type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "location", "data": { "city": "San Francisco", "country": "United States" } } }
          ]
        }
      },
      {
        "id": 5002, "type": "company", "listId": 1001, "createdAt": "2025-02-01T14:30:00Z", "creatorId": 1,
        "entity": {
          "id": 7002, "name": "Globex Inc", "domain": "globex.example.com", "domains": ["globex.example.com"], "isGlobal": true,
          "fields": [
            { "id": "field-1001-stage", "name": "Stage", "type": "list", "enrichmentSource": null, "value": { "type": "dropdown", "data": { "id": 2, "text": "Pending" } } }
          ]
        }
      }
    ],
    "1002": [
      {
        "id": 5101, "type": "person", "listId": 1002, "createdAt": "2025-01-20T09:00:00Z", "creatorId": 1,
        "entity": {
          "id": 7101, "firstName": "Alice", "lastName": "Chen", "primaryEmailAddress": "alice@acme.example.com", "emailAddresses": ["alice@acme.example.com"], "type": "external",
          "fields": [
            { "id": "field-1002-role", "name": "Role", "type": "list", "enrichmentSource": null, "value": { "type": "filterable-text", "data": "CTO" } }
          ]
        }
      },
      {
        "id": 5102, "type": "person", "listId": 1002, "createdAt": "2025-02-10T11:15:00Z", "creatorId": 1,
        "entity": {
          "id": 7102, "firstName": "Bob", "lastName": "Smith", "primaryEmailAddress": "bob@globex.example.com", "emailAddresses": ["bob@globex.example.com"], "type": "external",
          "fields": [
            { "id": "field-1002-role", "name": "Role", "type": "list", "enrichmentSource": null, "value": { "type": "filterable-text", "data": "PM" } }
          ]
        }
      }
    ],
    "1003": [
      {
        "id": 5201, "type": "opportunity", "listId": 1003, "createdAt": "2025-03-01T08:00:00Z", "creatorId": 1,
        "entity": {
          "id": 7201, "name": "Acme Upsell $50k", "listId": 1003,
          "fields": [
            { "id": "field-1003-amount", "name": "Amount", "type": "list", "enrichmentSource": null, "value": { "type": "number", "data": 50000 } },
            { "id": "field-1003-stage", "name": "Stage", "type": "list", "enrichmentSource": null, "value": { "type": "dropdown", "data": { "id": 1, "text": "Negotiation" } } }
          ]
        }
      }
    ]
  },
  "tenantPersonFields": [
    { "id": "affinity-data-current-organization", "name": "Current Organization", "type": "enriched", "valueType": "company",         "enrichmentSource": "affinity-data" },
    { "id": "affinity-data-job-titles",           "name": "Job Titles",           "type": "enriched", "valueType": "filterable-text-multi", "enrichmentSource": "affinity-data" }
  ],
  "tenantCompanyFields": [
    { "id": "affinity-data-industry",          "name": "Industry",          "type": "enriched", "valueType": "filterable-text-multi", "enrichmentSource": "affinity-data" },
    { "id": "affinity-data-number-of-employees","name": "Number of Employees","type": "enriched", "valueType": "number",               "enrichmentSource": "affinity-data" }
  ],
  "tenantPersons": [
    {
      "id": 7101, "firstName": "Alice", "lastName": "Chen",
      "primaryEmailAddress": "alice@acme.example.com", "emailAddresses": ["alice@acme.example.com"], "type": "external",
      "fields": [
        { "id": "affinity-data-current-organization", "name": "Current Organization", "type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "company", "data": { "id": 7001, "name": "Acme Corp", "domain": "acme.example.com" } } },
        { "id": "affinity-data-job-titles",           "name": "Job Titles",           "type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "filterable-text-multi", "data": ["CTO"] } }
      ]
    },
    {
      "id": 7102, "firstName": "Bob", "lastName": "Smith",
      "primaryEmailAddress": "bob@globex.example.com", "emailAddresses": ["bob@globex.example.com"], "type": "external",
      "fields": [
        { "id": "affinity-data-current-organization", "name": "Current Organization", "type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "company", "data": { "id": 7002, "name": "Globex Inc", "domain": "globex.example.com" } } },
        { "id": "affinity-data-job-titles",           "name": "Job Titles",           "type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "filterable-text-multi", "data": ["PM"] } }
      ]
    },
    {
      "id": 7103, "firstName": "Carol", "lastName": "Diaz",
      "primaryEmailAddress": "carol@wayne.example.com", "emailAddresses": ["carol@wayne.example.com"], "type": "external",
      "fields": [
        { "id": "affinity-data-current-organization", "name": "Current Organization", "type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "company", "data": { "id": 7003, "name": "Wayne Enterprises", "domain": "wayne.example.com" } } },
        { "id": "affinity-data-job-titles",           "name": "Job Titles",           "type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "filterable-text-multi", "data": ["VP Engineering"] } }
      ]
    }
  ],
  "tenantCompanies": [
    {
      "id": 7001, "name": "Acme Corp", "domain": "acme.example.com", "domains": ["acme.example.com"], "isGlobal": true,
      "fields": [
        { "id": "affinity-data-industry",           "name": "Industry",           "type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "filterable-text-multi", "data": ["Software", "SaaS"] } },
        { "id": "affinity-data-number-of-employees","name": "Number of Employees","type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "number", "data": 250 } }
      ]
    },
    {
      "id": 7002, "name": "Globex Inc", "domain": "globex.example.com", "domains": ["globex.example.com"], "isGlobal": true,
      "fields": [
        { "id": "affinity-data-industry",           "name": "Industry",           "type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "filterable-text-multi", "data": ["Manufacturing"] } },
        { "id": "affinity-data-number-of-employees","name": "Number of Employees","type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "number", "data": 1200 } }
      ]
    },
    {
      "id": 7003, "name": "Wayne Enterprises", "domain": "wayne.example.com", "domains": ["wayne.example.com"], "isGlobal": false,
      "fields": [
        { "id": "affinity-data-industry",           "name": "Industry",           "type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "filterable-text-multi", "data": ["Conglomerate"] } },
        { "id": "affinity-data-number-of-employees","name": "Number of Employees","type": "enriched", "enrichmentSource": "affinity-data", "value": { "type": "number", "data": 50000 } }
      ]
    }
  ],
  "tenantOpportunities": [
    { "id": 7201, "name": "Acme Upsell $50k", "listId": 1003 },
    { "id": 7202, "name": "Globex Pilot",     "listId": 1003 }
  ]
}' > /dev/null
echo -e "${GREEN}Fake Affinity seeded (3 lists, 7 list fields, 5 list entries, 3 people, 3 companies, 2 opportunities)${NC}"
echo ""

# Set URL overrides so the server redirects connector API calls to fakes
export API_URL_OVERRIDES="https://api.airtable.com=http://localhost:4646,https://test.wp.local=http://localhost:4647,https://quickbooks.api.intuit.com=http://localhost:4648,https://sandbox-quickbooks.api.intuit.com=http://localhost:4648,https://test.mocoapp.com=http://localhost:4649,https://app.audienceful.com=http://localhost:4651,https://admin.memberstack.com=http://localhost:4652,https://api.hubapi.com=http://localhost:4653,https://api.affinity.co=http://localhost:4654"

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
echo -e "  ${MAGENTA}Fake Memberstack${NC}:  http://localhost:4652"
echo -e "  ${MAGENTA}Fake HubSpot${NC}:     http://localhost:4653"
echo -e ""
echo -e "  ${MAGENTA}API overrides${NC}:  All connectors → localhost fakes"
echo -e "  ${YELLOW}Test domains${NC}:  WordPress=test.wp.local  Moco=test.mocoapp.com"
echo -e "${YELLOW}========================================${NC}"
echo ""
echo -e "${YELLOW}Press Ctrl+C to stop all services${NC}"
echo ""

# Wait for all background processes
wait
