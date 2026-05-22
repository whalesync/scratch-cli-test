# Scratch Server

The NestJS backend for the Scratch application.

---

## Setup & Development

### Install Node and Dependencies

```console
# Install and activate the right version of Node
nvm install
nvm use

# Install all dependencies
yarn install
```

### Environment Variables

Create a `.env` file by copying `.env.example`:

```bash
cp .env.example .env
```

Key variables to configure:

```env
# Server
PORT=3010

# Database
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/scratchpad?schema=public"

# Service Type (FRONTEND, WORKER, CRON, or MONOLITH)
SERVICE_TYPE=MONOLITH
```

Some values require reaching out to team members or checking 1Password.

### Set Up the Database

Start Docker services (PostgreSQL, Redis):

```console
docker compose -f localdev/docker-compose.yml up -d
```

Install PostgreSQL tools (first time only):

```console
brew install libpq
brew link --force libpq
```

Then you can create a database called 'scratchpad':

```console
createdb -h localhost -p 5432 -U postgres scratchpad
# Password: postgres
```

Run migrations:

```console
yarn run migrate
```

### Create an OpenRouter Account

The agent server uses OpenRouter for LLM access:

1. Create account at [OpenRouter.ai](https://openrouter.ai/)
2. Get provisioning key from [Provisioning Keys](https://openrouter.ai/settings/provisioning-keys)
3. Set `OPENROUTER_PROVISIONING_KEY` in `.env`
4. Create API key from [API keys](https://openrouter.ai/settings/keys)

### Google Cloud ADC (for `/upload-patch` signing)

The `/upload-patch/init` endpoint signs a V4 presigned GCS URL using user ADC + impersonated service-account signing (`GCS_LOCAL_SIGNING_SA` in `.env`). The ADC refresh token expires periodically; once it does, the endpoint returns HTTP 500 with an `invalid_grant: reauth related error (invalid_rapt)` from `Impersonated.sign()` — visible in the server console, and the cause of upload/publish failures from `scratchmd` and the CLI integration tests.

Refresh with:

```bash
gcloud auth application-default login
```

Then restart the server — the `Storage` auth client is constructed once at boot and caches the credential.

#### One-time IAM grant for new engineers

Signing impersonates `GCS_LOCAL_SIGNING_SA`, so your gcloud user needs `roles/iam.serviceAccountTokenCreator` on that service account. Without it the server returns HTTP 500 with `Permission 'iam.serviceAccounts.signBlob' denied on resource` from `Impersonated.sign()`.

This must be run by someone in the **Operator** group (project IAM admins):

```bash
gcloud iam service-accounts add-iam-policy-binding \
  cloudrun-service-account@spv1eu-test.iam.gserviceaccount.com \
  --member="user:YOUR_EMAIL@whalesync.com" \
  --role="roles/iam.serviceAccountTokenCreator" \
  --project=spv1eu-test
```

You can list the currently configured accounts using this command:

```bash
gcloud iam service-accounts get-iam-policy cloudrun-service-account@spv1eu-test.iam.gserviceaccount.com --project spv1eu-test --format=json 2>&1 | python3 -c "import sys,json; p=json.load(sys.stdin); [print(b['role'],'->',m) for b in p['bindings'] for m in b['members']]"
```

### Start the Server

```bash
yarn run start:dev
```

### Create Admin Account

1. Go to http://localhost:3000 and create an account
2. Update your user's `role` in the database to `ADMIN` for dev tools access

## Available Commands

```bash
# Development with watch mode
yarn run start:dev

# Build for production
yarn run build

# Run production build
yarn run start:prod

# Run database migrations
yarn run migrate

# Generate Prisma client
yarn run prisma:generate
```

## OpenRouter Management

Scratch uses OpenRouter.ai for LLM access. Each user has a scoped API key (user-provided or auto-provisioned).

### Production

1. Log in at [OpenRouter](https://openrouter.ai/) with Google SSO
2. Switch to Whalesync organization
3. View API keys and usage

### Test & Staging

1. Log in with Google SSO
2. Switch to Whalesync-Test organization
3. Credentials in 1Password (team@whalesync.com)

## Feature Flags

Feature flags are managed in [ExperimentsService](./src/experiments/experiments.service.ts) using [OpenFeature](https://openfeature.dev/) with PostHog as the provider.

- **Test**: [Test Feature Flags](https://us.posthog.com/project/225935/feature_flags?tab=overview)
- **Production**: [Production Feature Flags](https://us.posthog.com/project/214130/feature_flags?tab=overview)

**Important**: Do not set `Persist flag across authentication steps` on PostHog - this will cause FlagNotFoundError.

### Integration Tests

The integration tests run against the test environment by default at https://test.scratch.md. You need a Clerk user ID to run them. The tests will expect the account to have at least one snapshot with at least one table existing already, and will fail if they aren't found.

```
INTEGRATION_TEST_USER_ID=user_xxx yarn run test:integration --verbose
```

You can run them against your local dev stack by setting the hostnames for the services in environment variables. You can create a .env.integration file by copying `.env.integration.example` and adding your local user's clerkId.

```
cp .env.integration.example .env.integration
# edit .env.integration
yarn run test:integration --verbose
```

NOTE: These tests rely on Jest running the cases inside a single describe block in order. When debugging via VS Code, sometimes they seem to execute out of order, regardless of how Jest is configured.

## Stripe Integration

Stripe handles payments via hosted portals and webhooks. See [PaymentModule](src/payment/) for implementation details.

### Testing Stripe Locally

1. **Start ngrok**: `ngrok http 3010`

2. **Register webhook** in [Stripe Dashboard](https://dashboard.stripe.com/) (Test sandbox):
   - Events: `checkout.session.completed`, `customer.subscription.*`, `invoice.*`
   - Endpoint: `https://YOUR_NGROK.ngrok-free.app/payment/webhook`
   - Copy signing secret

3. **Update `.env`**:

   ```env
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_API_KEY=sk_test_...
   ```

4. **Restart server**

## Microservice Architecture

The application supports different service types via the `SERVICE_TYPE` environment variable:

- **FRONTEND**: API server handling HTTP requests
- **WORKER**: Background job processor
- **CRON**: Scheduled task runner
- **MONOLITH**: All services combined (for local development)

This allows horizontal scaling of different concerns in production while maintaining simplicity in development.

## MCP Connector (Claude Integration)

The server exposes a remote MCP (Model Context Protocol) endpoint that allows Claude to read workbook data via natural language. It implements OAuth 2.1 with PKCE for authentication and the Streamable HTTP transport for JSON-RPC messaging.

### Testing MCP Locally with Claude

Claude.ai needs to reach your local services over the internet, so you need tunnels for both the server and client.

1. **Start ngrok tunnels** in two separate terminals:

   ```bash
   # Terminal 1: Server tunnel
   ngrok http 3010

   # Terminal 2: Client tunnel
   ngrok http 3000
   ```

2. **Add the ngrok URLs to your `.env`**:

   ```env
   MCP_SERVER_URL=https://<server-tunnel>.ngrok.io
   MCP_CLIENT_URL=https://<client-tunnel>.ngrok.io
   ```

3. **Restart the server** so it picks up the new URLs.

4. **Register the connector in Claude**:
   - Go to **Settings > Connectors** in Claude
   - Click **Add custom connector**
   - Enter the MCP server URL: `https://<server-tunnel>.ngrok.io/mcp`
   - Click **Add**, then **Connect** to complete the OAuth flow

5. **Enable in a conversation**:
   - Click the **+** button in the Claude chat
   - Select **Connectors** and toggle Scratch on

### Architecture

- **OAuth endpoints** (`/mcp-auth/*`) — Authorization server for token issuance
- **Well-known endpoints** (`/.well-known/oauth-*`) — OAuth metadata discovery
- **MCP endpoint** (`/mcp`) — JSON-RPC handler for `initialize`, `tools/list`, `tools/call`
- **Consent page** (`/mcp/authorize` on the client) — User approves Claude's access
