# Runbook: Debugging MCP OAuth Workflow Issues

When Claude (or another MCP client) fails to connect to the Scratch MCP server, use this runbook to isolate where the OAuth flow is breaking.

## OAuth Flow Overview

The MCP OAuth flow follows these steps in order:

1. Client sends `POST /mcp` → gets `401 Unauthorized`
2. Client fetches `GET /.well-known/oauth-protected-resource` → gets resource metadata
3. Client fetches `GET /.well-known/oauth-authorization-server` → gets authorization server metadata
4. Client calls `POST /mcp-auth/register` → gets a dynamic `client_id`
5. Client redirects user to `/mcp-auth/authorize` → server redirects to consent page at `https://{CLIENT_HOST}/mcp/authorize`
6. User approves on consent page → callback to `/mcp-auth/callback`
7. Client exchanges code at `POST /mcp-auth/token` → gets access + refresh tokens
8. Client retries `POST /mcp` with `Authorization: Bearer <token>` → success

A failure at any step will prevent the connection. Test each step in order to find the break.

## Environment URLs

| Environment | API Server                      | Client App                  |
| ----------- | ------------------------------- | --------------------------- |
| Local       | `http://localhost:3010`         | `http://localhost:3000`     |
| Test        | `https://test-api.scratch.md`   | `https://test.scratch.md`   |
| Production  | `https://api.scratch.md`        | `https://app.scratch.md`    |

Replace `$API` and `$CLIENT` below with the appropriate URLs.

## Step-by-Step Verification

### Step 1: Verify the MCP endpoint exists

```bash
curl -s -o /dev/null -w "%{http_code}" -X POST $API/mcp
```

**Expected:** `401` (Unauthorized — the route exists and the auth guard is active)

**If 404:** The `/mcp` route is not registered. Check:
- Is the `McpModule` imported in `app.module.ts`?
- Is the server deployment up to date?
- Are there path prefix or proxy issues in the load balancer / ingress?

### Step 2: Verify protected resource metadata

```bash
curl -s $API/.well-known/oauth-protected-resource | jq .
```

**Expected response:**
```json
{
  "resource": "$API/mcp",
  "authorization_servers": ["$API"],
  "scopes_supported": ["read:workbooks", "read:files"],
  "bearer_methods_supported": ["header"]
}
```

**If 404:** The `.well-known` route is not registered. Check the `McpAuthController`.

**Things to verify:**
- `resource` points to the correct API host (not `localhost`)
- `authorization_servers` uses the same origin as the API

### Step 3: Verify authorization server metadata

```bash
curl -s $API/.well-known/oauth-authorization-server | jq .
```

**Expected response:**
```json
{
  "issuer": "$API",
  "authorization_endpoint": "$API/mcp-auth/authorize",
  "token_endpoint": "$API/mcp-auth/token",
  "registration_endpoint": "$API/mcp-auth/register",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["read:workbooks", "read:files"]
}
```

**Things to verify:**
- All endpoint URLs point to the correct API host
- `issuer` matches the API origin exactly

### Step 4: Test dynamic client registration

```bash
curl -s -X POST $API/mcp-auth/register \
  -H "Content-Type: application/json" \
  -d '{"client_name":"debug-test","redirect_uris":["http://localhost:9999/callback"]}' | jq .
```

**Expected:** A JSON response containing a `client_id`.

**If error:** Check the `McpAuthService.registerClient` logic and that the database/store is accessible.

### Step 5: Verify the authorize endpoint redirects to the consent page

```bash
curl -s -o /dev/null -w "%{http_code}\n%{redirect_url}" \
  "$API/mcp-auth/authorize?client_id=TEST&redirect_uri=http://localhost:9999/callback&response_type=code&code_challenge=test&code_challenge_method=S256&scope=read:workbooks"
```

**Expected:** `302` redirect to `$CLIENT/mcp/authorize?...`

**If the redirect goes to the wrong host:** Check the `MCP_CLIENT_URL` or equivalent environment variable on the server.

### Step 6: Verify the client consent page loads

```bash
curl -s -o /dev/null -w "%{http_code}" "$CLIENT/mcp/authorize"
```

**Expected:** `200` (the page itself will show "Invalid Authorization Request" without query params — that's normal)

**If 404:** The client-side `/mcp/authorize` page is not deployed. Check:
- Does the page exist in `client/src/app/mcp/authorize/page.tsx`?
- Has the latest client build been deployed to this environment?

**If redirect to sign-in:** This is expected — the consent page requires authentication. The user must be signed in for the OAuth flow to complete.

## Common Failure Modes

| Symptom | Likely Cause |
| ------- | ------------ |
| Claude reports 404 | The client consent page (`/mcp/authorize`) is not deployed, or the MCP server URL is misconfigured in Claude |
| 401 on `POST /mcp` with valid token | Token expired, wrong signing key, or `ENCRYPTION_MASTER_KEY` mismatch between environments |
| OAuth flow starts but consent page says "Invalid Authorization Request" | Missing or malformed query parameters in the redirect — check Step 5 redirect URL |
| Everything works locally but not on test/prod | Environment variables (`MCP_CLIENT_URL`, `JWT_SECRET`, etc.) not set or pointing to wrong hosts |
| Client gets token but `POST /mcp` still fails | Check that the token scopes match what the MCP guard expects |

## Environment Variables to Check

Verify these are set correctly on the server in the target environment:

- `MCP_CLIENT_URL` — Must point to the client app origin (e.g., `https://test.scratch.md`)
- `JWT_SECRET` or token signing key — Must be consistent
- `ENCRYPTION_MASTER_KEY` — Required for credential handling
- Any OAuth-specific secrets for token generation
