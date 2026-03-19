# Remote MCP Connector for Claude — Architecture Plan

## Overview

This document outlines the architecture for implementing a remote MCP (Model Context Protocol) server within Scratch, enabling Claude to act as a custom connector that lets users interact with their Workbook data through natural language.

When connected, Claude will be able to list workbooks, browse data folders, read record files, search across content, and answer questions about the user's data — all authenticated via OAuth 2.1.

## Background: What is Remote MCP?

Claude supports **custom connectors** via remote MCP servers. These are internet-hosted services that expose tools and resources over the **Streamable HTTP** transport protocol. Claude discovers and invokes these tools on behalf of the user during conversations.

Key protocol details:
- **Transport**: Streamable HTTP — a single HTTP endpoint accepting POST (JSON-RPC messages) and GET (SSE streams)
- **Auth**: OAuth 2.1 with PKCE, including metadata discovery (`/.well-known/oauth-authorization-server`) and dynamic client registration
- **Message format**: JSON-RPC 2.0 over HTTP, with optional SSE streaming for responses
- **Session management**: Server-assigned `Mcp-Session-Id` header for stateful sessions

## Registering the Connector with Claude

The Scratch MCP server must be registered as a custom connector in Claude before users can interact with it. The registration process differs by plan type.

### Server URL

The MCP endpoint exposed by the Scratch server will be:

```
https://app.scratch.so/api/mcp
```

This is the single Streamable HTTP endpoint that Claude will POST JSON-RPC messages to and GET SSE streams from. The OAuth endpoints (`/authorize`, `/token`, `/register`) are discovered relative to this URL's origin via `/.well-known/oauth-authorization-server`.

### For Team / Enterprise Plans (Admin Setup)

1. An **Organization Owner** goes to **Organization settings > Connectors** in Claude
2. Clicks **"Add custom connector"**
3. Enters the MCP server URL: `https://app.scratch.so/api/mcp`
4. Opens **Advanced settings** and enters:
   - **OAuth Client ID** — Pre-registered client ID for the organization (generated via Scratch admin or the dynamic registration endpoint)
   - **OAuth Client Secret** — If using a confidential client flow (optional; public clients with PKCE are also supported)
5. Clicks **"Add"**

Once the admin has added the connector, team members:
1. Go to **Settings > Connectors**
2. Find the Scratch connector (marked with a "Custom" label)
3. Click **"Connect"** — this triggers the OAuth 2.1 flow (browser opens the Scratch consent page, user logs in via Clerk, approves access)
4. Each team member gets their own access token scoped to their Scratch account

### For Pro / Max Individual Users

1. Go to **Settings > Connectors** in Claude
2. Click **"Add custom connector"**
3. Enter the MCP server URL: `https://app.scratch.so/api/mcp`
4. Optionally configure OAuth credentials in Advanced settings (if omitted, Claude uses dynamic client registration automatically)
5. Click **"Add"**, then **"Connect"** to complete the OAuth flow

### Using the Connector in Conversations

Once connected, users activate the Scratch connector per conversation:
1. Click the **"+"** button in the Claude chat interface
2. Select **"Connectors"**
3. Toggle **Scratch** on

Claude will then have access to the Scratch MCP tools (list workbooks, read files, etc.) and can answer questions about the user's data.

### Pre-registration vs. Dynamic Registration

There are two paths for obtaining OAuth client credentials:

| Approach | When to use | How it works |
|----------|-------------|--------------|
| **Dynamic registration** | Individual users, first-time setup | Claude automatically calls `POST /mcp-auth/register` to get a `client_id`. No manual configuration needed. |
| **Pre-registered client** | Team/Enterprise admins who want control | Admin generates a client ID + secret via a Scratch admin page or API, then enters them in Claude's Advanced settings. Allows the org to enforce specific redirect URIs and scopes. |

For the MVP, supporting **dynamic client registration** is sufficient — it provides the smoothest setup experience and is the MCP-recommended approach. Pre-registered clients can be added later for enterprise controls.

## Decision: Integrate into the Existing NestJS Server

### Recommendation: Add as a new NestJS module on the existing server

After analyzing the codebase, integrating the MCP endpoint directly into the NestJS server is the better approach for Scratch. Here's why:

**Why integration wins over a separate service:**

1. **Direct access to services** — The MCP tools need `FilesService`, `DataFolderService`, `WorkbookService`, and `ScratchGitService`. These are already wired up with proper auth context, Prisma transactions, and Redis pub/sub. Calling them over internal HTTP would add latency, error surface, and deployment complexity for no benefit.

2. **Auth reuse** — The existing `ScratchAuthGuard` and `ApiToken` infrastructure can be extended to support OAuth 2.1 token issuance. The server already has `OAuthModule` patterns for multiple providers, and Clerk JWT validation. Adding an OAuth authorization server is a natural extension.

3. **Single deployment** — Scratch already runs as `API`, `WORKER`, and `CRON` service types from the same codebase. The MCP endpoint is just another HTTP route on the API service — no new container, no new CI pipeline, no new infrastructure.

4. **NestJS is compatible** — The Streamable HTTP transport is just HTTP POST/GET endpoints with SSE. NestJS handles SSE natively via `@Sse()` decorators and `Observable` return types. The JSON-RPC message handling is a thin layer on top of standard request/response.

5. **Shared WebSocket/Redis infrastructure** — Real-time workbook events already flow through Redis pub/sub. The MCP server can subscribe to the same channels to push notifications via SSE when data changes.

**Mitigations for potential downsides:**

| Concern | Mitigation |
|---------|-----------|
| MCP protocol complexity in NestJS | Encapsulate all JSON-RPC handling in a dedicated `McpModule` with its own controller and message router |
| Scaling independently | The API service already scales horizontally; MCP requests are lightweight read-heavy operations |
| Protocol evolution | The `McpModule` is self-contained — swap transport or upgrade protocol version without touching other modules |

## Architecture

### Module Structure

```
client/src/app/mcp/
└── authorize/
    └── page.tsx                     # OAuth consent page (Clerk login required)

server/src/mcp/
├── mcp.module.ts                    # NestJS module definition
├── mcp.controller.ts                # Single /mcp endpoint (POST + GET + DELETE)
├── mcp-session.service.ts           # Session lifecycle (create, validate, terminate)
├── mcp-router.service.ts            # JSON-RPC method dispatcher
├── mcp-auth/
│   ├── mcp-oauth.controller.ts      # /authorize, /token, /register endpoints
│   ├── mcp-oauth.service.ts         # OAuth 2.1 authorization server logic
│   └── mcp-auth.guard.ts            # Bearer token validation for MCP requests
├── tools/
│   ├── tool-registry.ts             # Tool discovery and dispatch
│   ├── list-workbooks.tool.ts       # List user's workbooks
│   ├── list-folders.tool.ts         # List data folders in a workbook
│   ├── list-files.tool.ts           # List record files in a folder
│   ├── read-file.tool.ts            # Read a specific record file
│   ├── search-files.tool.ts         # Full-text search across files
│   └── get-folder-schema.tool.ts    # Get the schema for a data folder
├── resources/
│   ├── resource-registry.ts         # Resource URI routing
│   └── workbook-resource.provider.ts # scratch://workbook/{id}/... resources
├── dto/
│   ├── jsonrpc.dto.ts               # JSON-RPC request/response types
│   └── mcp-messages.dto.ts          # MCP-specific message types
└── __tests__/
    ├── mcp.controller.spec.ts
    ├── mcp-router.service.spec.ts
    └── tools/*.spec.ts
```

### Request Flow

```
Claude (MCP Client)
    │
    ▼
POST /mcp  (JSON-RPC request, Bearer token, Mcp-Session-Id)
    │
    ▼
McpController
    ├── mcp-auth.guard.ts validates Bearer token → resolves user
    ├── mcp-session.service.ts validates/creates session
    │
    ▼
McpRouterService (dispatches by JSON-RPC method)
    ├── "initialize"        → return capabilities + session ID
    ├── "tools/list"        → ToolRegistry.listTools()
    ├── "tools/call"        → ToolRegistry.dispatch(name, args, user)
    ├── "resources/list"    → ResourceRegistry.list(user)
    ├── "resources/read"    → ResourceRegistry.read(uri, user)
    └── "initialized" (notification) → 202 Accepted
```

### Authentication Flow

Claude's MCP client uses OAuth 2.1 with PKCE. The server must act as an OAuth authorization server:

```
1. Claude discovers auth endpoints:
   GET /.well-known/oauth-authorization-server
   → Returns metadata with authorize/token/register endpoints

2. Claude registers dynamically (first time):
   POST /mcp-auth/register
   → Returns client_id (stored by Claude)

3. User authorizes via browser:
   GET /mcp-auth/authorize?client_id=...&code_challenge=...&redirect_uri=...
   → NestJS redirects to React client at /mcp/authorize?state=...
   → React page requires Clerk login, shows consent UI ("Claude wants to access your workbooks")
   → On approval, React calls POST /mcp-auth/approve (with Clerk JWT + state)
   → Server generates auth code, redirects to Claude's redirect_uri with code

4. Claude exchanges code for token:
   POST /mcp-auth/token  (code + code_verifier)
   → Returns access_token (JWT or opaque token mapped to ApiToken)

5. All subsequent MCP requests include:
   Authorization: Bearer <access_token>
   Mcp-Session-Id: <session_id>
```

**Implementation approach for the OAuth server:**

Rather than building a full OAuth server from scratch, leverage the existing auth infrastructure. The consent UI follows the same pattern as CLI auth (`/cli/authorize`) — all user-facing UI lives in the React client, not on the NestJS server.

- **Authorization endpoint** (`GET /mcp-auth/authorize`) — NestJS encodes OAuth params (client_id, code_challenge, redirect_uri, scopes) into a base64 `state` param and redirects to the React client at `/mcp/authorize?state=...`. This mirrors how connector OAuth encodes context in state via `oauth.service.ts`.
- **Consent page** (`/client/src/app/mcp/authorize/page.tsx`) — React page that requires Clerk login (like `/cli/authorize`). Decodes the state, displays which scopes Claude is requesting, and shows an "Authorize" / "Deny" button. On approval, calls `POST /mcp-auth/approve` with the Clerk JWT and the state.
- **Approval endpoint** (`POST /mcp-auth/approve`) — Validates the Clerk JWT, generates an authorization code stored in Redis (short TTL), and returns a redirect URL to Claude's `redirect_uri` with the code.
- **Token endpoint** (`POST /mcp-auth/token`) — Validates the code + PKCE verifier, then creates an `ApiToken` record with `type: MCP` and appropriate scopes. Returns it as the access token.
- **Token validation** — Extend `ScratchAuthGuard` with a new strategy that looks up MCP tokens in the `ApiToken` table (similar to the existing `api-token.strategy.ts`).
- **Dynamic client registration** (`POST /mcp-auth/register`) — Store registered clients in a new `McpClient` database table with `client_id`, `redirect_uris`, and `client_name`.

### MCP Tools

These are the tools Claude will be able to invoke on behalf of the user:

| Tool | Description | Backing Service |
|------|-------------|-----------------|
| `list_workbooks` | List all workbooks the user has access to | `WorkbookService.findAll()` |
| `get_workbook` | Get details about a specific workbook | `WorkbookService.findOne()` |
| `list_folders` | List data folders in a workbook | `DataFolderService.findByWorkbook()` |
| `get_folder_schema` | Get the schema/field definitions for a folder | `DataFolderService.getSchema()` |
| `list_files` | List record files in a folder (paginated) | `FilesService.listByFolder()` |
| `read_file` | Read the full content of a record file | `FilesService.readFile()` |
| `search_files` | Search across files in a workbook by content | `FilesService` + git grep |
| `resolve_references` | Follow foreign key references between records | `FilesService.resolveReferences()` |

Example tool definition returned by `tools/list`:

```json
{
  "name": "list_files",
  "title": "List Record Files",
  "description": "List record files in a data folder. Returns file names, paths, and summary metadata. Use pagination cursor for large folders.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "workbookId": { "type": "string", "description": "The workbook ID" },
      "folderId": { "type": "string", "description": "The data folder ID" },
      "cursor": { "type": "string", "description": "Pagination cursor from previous response" },
      "limit": { "type": "number", "description": "Max files to return (default 50, max 200)" }
    },
    "required": ["workbookId", "folderId"]
  }
}
```

### MCP Resources (Optional, Phase 2)

Resources provide a browsable URI namespace. Claude can discover and read them directly:

```
scratch://workbooks                           → list of workbooks
scratch://workbooks/{id}                      → workbook details
scratch://workbooks/{id}/folders              → list of folders
scratch://workbooks/{id}/folders/{fid}/schema → folder schema
scratch://workbooks/{id}/files/{path}         → file content
```

Resources are lower priority than tools since Claude primarily interacts through tool calls.

### Session Management

- On `initialize` request, generate a cryptographically secure session ID (UUID v4)
- Store session state in Redis with a TTL (e.g., 1 hour, refreshed on activity):
  - `mcp:session:{sessionId}` → `{ userId, workbookContext, createdAt }`
- Return session ID via `Mcp-Session-Id` response header
- Validate session ID on all subsequent requests
- On DELETE to `/mcp`, terminate the session (remove from Redis)

### SSE Streaming

For long-running tool calls (e.g., searching across many files), the controller returns an SSE stream:

```typescript
@Post('mcp')
async handlePost(@Req() req, @Res() res) {
  const message = req.body; // JSON-RPC message

  if (isNotificationOrResponse(message)) {
    res.status(202).send();
    return;
  }

  // For requests that complete quickly, return JSON directly
  if (canRespondSynchronously(message)) {
    res.setHeader('Content-Type', 'application/json');
    res.json(await this.mcpRouter.handle(message, req.user));
    return;
  }

  // For longer operations, stream via SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const result = await this.mcpRouter.handle(message, req.user);
  res.write(`data: ${JSON.stringify(result)}\n\n`);
  res.end();
}
```

## Database Changes

### New Tables

```prisma
model McpClient {
  id            String   @id @default(uuid())
  clientId      String   @unique  // OAuth client_id
  clientName    String?
  redirectUris  String[]
  createdAt     DateTime @default(now())
}

model McpAuthorizationCode {
  // Alternatively store in Redis with short TTL
  id            String   @id @default(uuid())
  code          String   @unique
  clientId      String
  userId        String
  codeChallenge String
  redirectUri   String
  scopes        String[]
  expiresAt     DateTime
  createdAt     DateTime @default(now())
}
```

### ApiToken Changes

Add `MCP` to the `TokenType` enum:

```prisma
enum TokenType {
  AGENT
  WEBSOCKET
  USER
  MCP       // new
}
```

## Implementation Phases

### Phase 1: Core MCP Server (MVP)

1. **McpModule scaffolding** — Controller, router, session service
2. **OAuth 2.1 authorization server** — Metadata discovery, authorize, token, register endpoints
3. **MCP auth guard** — Bearer token validation using ApiToken table
4. **Read-only tools** — `list_workbooks`, `list_folders`, `list_files`, `read_file`, `get_folder_schema`
5. **JSON-RPC handling** — Initialize, tools/list, tools/call
6. **Integration test** — End-to-end flow with a test MCP client

### Phase 2: Enhanced Capabilities

1. **Search tool** — `search_files` with git grep backend
2. **Reference resolution** — `resolve_references` tool for following foreign keys
3. **SSE streaming** — For large result sets
4. **Resource providers** — `scratch://` URI namespace
5. **Rate limiting** — Per-user, per-session limits

### Phase 3: Write Operations & Real-time

1. **Write tools** — `update_file`, `create_file` (with appropriate confirmation patterns)
2. **Real-time notifications** — Subscribe to workbook changes via Redis pub/sub, push via SSE
3. **Tool change notifications** — Notify Claude when available tools change based on workbook context

## Security Considerations

- **Scopes**: MCP tokens should have explicit scopes (`read:workbooks`, `read:files`, `write:files`). Phase 1 is read-only.
- **PKCE required**: All OAuth flows must use PKCE (code_challenge + code_verifier).
- **HTTPS only**: MCP endpoint and all OAuth endpoints must be served over HTTPS.
- **Origin validation**: Validate the `Origin` header on all MCP requests.
- **Token expiration**: MCP access tokens should have a short lifetime (1 hour) with refresh token support.
- **Redirect URI validation**: Strictly validate redirect URIs against registered values.
- **Input validation**: All tool arguments validated with class-validator DTOs.
- **Workbook access control**: Every tool call must verify the authenticated user has access to the requested workbook.

## Configuration

New environment variables:

```env
# MCP OAuth
MCP_OAUTH_ISSUER=https://app.scratch.so        # OAuth issuer URL
MCP_AUTH_CODE_TTL=300                            # Authorization code TTL in seconds
MCP_ACCESS_TOKEN_TTL=3600                        # Access token TTL in seconds
MCP_REFRESH_TOKEN_TTL=2592000                    # Refresh token TTL (30 days)
MCP_SESSION_TTL=3600                             # MCP session TTL in seconds
```

## Open Questions

1. **Clerk integration for OAuth consent** — Should the authorize endpoint redirect to Clerk's hosted login, or render a custom consent page that uses Clerk's session?
2. **Multi-workbook vs. single-workbook scope** — Should a single MCP connection be scoped to one workbook, or allow access to all of the user's workbooks?
3. **Tool granularity** — Should we expose one broad `query_data` tool that handles natural language queries, or many specific tools that let Claude compose its own queries?
4. **Write operations** — What confirmation/approval model should be used before Claude modifies data?
5. **Usage tracking** — Should MCP tool invocations be logged to `AuditLogEvent`?
