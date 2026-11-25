# CLI Module

This module provides REST API endpoints for CLI authentication with Scratch.md.

It also serves the `/cli/v1` surface that `scratchmd` (and Scratch Desktop, through its bundled `scratchmd`) uses
for workbooks, connections, linked folders, syncs, and publishing. One of those endpoints is
`GET /cli/v1/workbooks/:workbookId/table-specs` (DEV-13025, `cli-table-specs.controller.ts`): every linked folder's
table spec and default view, read from Postgres, which `scratchmd` writes into its local cache instead of copying them
from git. See [the API reference](../assets/api-reference.md#list-workbook-table-specs-cli).

`scratchmd-client-identification.ts` classifies a request's User-Agent. A User-Agent of exactly `Scratch-cli/1.0`
comes from a binary from before DEV-13025, which still copies table specs from git. `cli_list_workbooks` and
`cli_list_table_specs` events carry the result as `scratchmdClientKind`.

## Authentication Flow

The CLI uses a device code flow for authentication:

1. CLI calls `/cli/v1/auth/initiate` to get a user code and polling code
2. User visits the verification URL and enters the user code
3. CLI polls `/cli/v1/auth/poll` until the user approves or denies
4. On approval, CLI receives an API token for future requests

## Endpoints

All endpoints are prefixed with `/cli/v1`.

### POST /cli/v1/auth/initiate

Starts the device code authorization flow.

**Response:**

```json
{
  "userCode": "ABC123",
  "pollingCode": "poll_xyz789",
  "verificationUrl": "https://app.scratch.md/cli-auth",
  "expiresIn": 600,
  "interval": 5
}
```

### POST /cli/v1/auth/poll

Polls for authorization status.

**Request Body:**

```json
{
  "pollingCode": "poll_xyz789"
}
```

**Response (pending):**

```json
{
  "status": "pending"
}
```

**Response (approved):**

```json
{
  "status": "approved",
  "apiToken": "cli_token_abc123",
  "userEmail": "user@example.com",
  "tokenExpiresAt": "2024-07-15T10:30:00.000Z"
}
```

**Response (denied/expired):**

```json
{
  "status": "denied",
  "error": "User denied the authorization request"
}
```

### POST /cli/v1/auth/verify

Called by the web app when the user enters their code and approves/denies.

**Request Body:**

```json
{
  "userCode": "ABC123",
  "approved": true
}
```

## Example Usage

```bash
# Initiate auth flow
curl -X POST http://localhost:3010/cli/v1/auth/initiate

# Poll for status
curl -X POST http://localhost:3010/cli/v1/auth/poll \
  -H "Content-Type: application/json" \
  -d '{"pollingCode": "poll_xyz789"}'
```
