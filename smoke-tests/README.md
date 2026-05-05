# Smoke Tests

End-to-end smoke tests for pull and publish pipelines. Tests hit the real NestJS API server, which talks to fake connector APIs (e.g. fake Airtable) instead of real external services. Everything runs in Docker.

See [smoke-test-plan.md](/docs/plans/resolved/smoke-test-plan.md) for the full design and test case descriptions.

## Prerequisites

- Docker and Docker Compose
- Node.js 22+ (via nvm)
- `CLERK_SECRET_KEY` for the test Clerk environment

## Quick Start

All commands run from the repo root.

**First-time setup:** copy the example env and add your Clerk secret key:

```bash
cp smoke-tests/.env.integration.example smoke-tests/.env.integration
# Edit smoke-tests/.env.integration and set CLERK_SECRET_KEY
```

**Run the smoke tests:**

```bash
smoke-tests/run.sh
```

This starts the Docker stack (building images if needed), waits for all services to be healthy, and runs the tests. You can pass extra args to Jest:

```bash
smoke-tests/run.sh pull/pull-basic.spec.ts
```

## Tear Down

```bash
docker compose -f smoke-tests/docker-compose.smoke-test.yml down -v
```

## Services

| Service       | Host Port | Description                         |
| ------------- | --------- | ----------------------------------- |
| postgres      | 5442      | Test database                       |
| redis         | 6389      | BullMQ job queue                    |
| scratch-git-2 | 3110/3111 | Git storage (API + HTTP backend)    |
| fake-airtable | 4656      | Fake Airtable API (in-memory store) |
| server        | 3020      | NestJS API server (monolith mode)   |

Ports are offset from the defaults so they don't conflict with local dev services.

## Environment Variables

| Variable                   | Default                            | Description                   |
| -------------------------- | ---------------------------------- | ----------------------------- |
| `CLERK_SECRET_KEY`         | (required)                         | Clerk test environment secret |
| `CLERK_PUBLISHABLE_KEY`    | (defaults to dev key)              | Clerk publishable key         |
| `INTEGRATION_TEST_USER_ID` | `user_31KEiMetcHKOtODOxcYSHeaRgDC` | Clerk user ID for test auth   |
| `SMOKE_TEST_SERVER_URL`    | `http://localhost:3020`            | Server URL for test client    |
| `FAKE_AIRTABLE_URL`        | `http://localhost:4656`            | Fake Airtable URL for seeding |

## Troubleshooting

**Services not healthy?** Check logs:

```bash
docker compose -f smoke-tests/docker-compose.smoke-test.yml logs server
docker compose -f smoke-tests/docker-compose.smoke-test.yml logs scratch-git-2
```

**Rebuild after code changes:**

```bash
docker compose -f smoke-tests/docker-compose.smoke-test.yml up --build -d
```

**Run a single test file:**

```bash
cd smoke-tests
yarn test:smoke -- pull/pull-basic.spec.ts
```
