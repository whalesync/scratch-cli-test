# CLAUDE.md

Instructions for Claude Code when working in this repository. Subdirectory CLAUDE.md files contain additional rules scoped to their directories — always read them before working in those areas.

## Critical Rules

- **Always use `yarn`**, never `npm`. This applies to installs, running scripts, and adding dependencies.
- **Always run `nvm use`** before any Node-dependent command. Run it in the directory you're working in (e.g. `server/`, `client/`). You do NOT need to source `~/.nvm/nvm.sh`.
- **Prefer running commands from the repo root** using Turborepo (see [Development Commands](#development-commands)).
- **Always run `yarn build`, `yarn lint`, and `yarn format` from the repo root** after completing a series of code changes to verify nothing is broken.
- Look for **Skills** to help with specific tasks in the `.claude/skills` folder

## Project Overview

**Scratch** (codename: "Spinner") is a content management system that syncs data between external services (e.g. Airtable, Webflow) and a git-based storage layer. It provides knowledge workers a VS Code-like workspace for managing content across services.

## Monorepo Structure

This is a Yarn workspaces monorepo managed by Turborepo.

| Package     | Path           | Description                                                 |
| ----------- | -------------- | ----------------------------------------------------------- |
| Client      | `/client`      | Next.js web app (port 3000)                                 |
| Server      | `/server`      | NestJS API server (port 3010)                               |
| scratch-git | `/scratch-git` | Git operations library                                      |
| scratch-cli | `/scratch-cli` | CLI tool in go for interacting with Scratch and local files |

| shared-types | `/packages/shared-types` | Yarn package containing shared TypeScript types between client and server |
| Infrastructure | `/terraform` | Terraform for GCP test and production environments |

## Domain Model: Files and Folders

Scratch models external data records as files organized in a tree structure. Understanding this model is essential for working with the codebase:

- A **Workbook** is a workspace that owns a Git repository. All files within a Workbook have unique paths.
- A **DataFolder** represents a directory in the tree. `DataFolder.path` always starts with `/` and uses POSIX format.
- A **Record file** is a data file that belongs to a DataFolder. Its full path is `DataFolder.path` + filename.
- Record files are stored in the Workbook's Git repository and can be indexed in database tables for pull, publish, and sync operations.
- Each record file has a **remote ID** linking it to a record in an external service (e.g. an Airtable row or Webflow item).
- Always reference files by their full path (folder path + filename).

## Development Commands

### Initial Setup

**Prerequisites**: Node.js ≥22 (via nvm), Docker, Yarn 1.x

```bash
cd client && yarn install && cd ..
cd server && yarn install && cd ..

# Copy .env.example → .env in client/ and server/, then configure

# Start PostgreSQL + Redis
cd server/localdev && docker compose up -d && cd ../..

# Create database (first time only — requires: brew install libpq && brew link --force libpq)
createdb -h localhost -p 5432 -U postgres scratchpad  # password: postgres

# Run migrations
cd server && yarn run migrate
```

### Root-Level Commands (Turborepo)

```bash
yarn dev              # Start all dev servers (client, server, scratch-git, shared-types watch)
yarn build            # Build all packages with caching and dependency ordering
yarn migrate          # Run database migrations
yarn lint             # Lint all packages
yarn format           # Format all packages
yarn test             # Run tests across all packages
yarn test:integration # Run integration tests across all packages
```

### Per-Package Commands

Run these from within the package directory:

**Client** (`/client`):
`yarn run dev` | `yarn run build` | `yarn run lint` | `yarn run lint-strict`

**Server** (`/server`):
`yarn run start:dev` | `yarn run build` | `yarn run lint` | `yarn run lint-fix` | `yarn run test` | `yarn run test:watch` | `yarn run migrate`

## Code Conventions

### Code Style

- Prettier with organize-imports plugin
- Single quotes, semicolons, 120-char line width, trailing commas everywhere
- `kebab-case` for filenames: `user-service.ts`
- `PascalCase` for classes: `UserService`
- Files end with a newline

### Client Conventions

- Next.js **App Router** (not Pages Router)
- Mantine UI components — read `client/src/app/components/UI_SYSTEM.md` before writing UI code
- Zustand for state management, SWR for server data fetching
- Use `next/link` for links, never `<a>` tags
- Icons: `lucide-react` wrapped in `StyledLucideIcon`
- Use `console.debug`, not `console.log`

### Server Conventions

- NestJS modular architecture — each feature is a self-contained module
- Prisma ORM for standard queries, Knex for complex queries
- Use `WSLogger.info|warn|error` for logging, never `console.log`
- Do not use `as any` to solve type issues

### NestJS DTO Pattern

```
class CreateFooDto {
  @IsString() @IsOptional() name?: string;  // All properties optional with class-validator decorators
}
type ValidatedCreateFooDto = Required<Pick<CreateFooDto, 'name'>>;  // Required fields declared explicitly
```

### NestJS Module Structure

```
/module-name/
├── module-name.module.ts        # NestJS module definition
├── module-name.controller.ts    # HTTP endpoints
├── module-name.service.ts       # Business logic
├── module-name.types.ts         # Type definitions
├── dto/*.dto.ts                 # Request/response DTOs
├── entities/*.entity.ts         # Database entities
└── __tests__/*.spec.ts          # Jest tests
```

### Client/Server Communication

When creating new REST endpoints, keep these files in sync:

```
client/src/
├── hooks/use-[resource].ts              # SWR hook for components
├── lib/api/keys.ts                      # SWR cache keys
├── lib/api/[resource].ts                # API fetch functions
└── types/server-entities/[resource].ts  # TypeScript interfaces

server/src/[resource]/
├── [resource].controller.ts             # API endpoints
├── entities/*.entity.ts                 # Database entities
└── dto/*.dto.ts                         # Request/response DTOs
```

#### Real-time Updates

Redis pub/sub → WebSocket gateway → connected clients. Multiple server instances coordinate via Redis.

## Important Notes

- React Strict Mode runs components twice in dev (affects debugging)
- Feature flags: OpenFeature + PostHog — do NOT enable "Persist flag across authentication steps" (causes errors)
- Connection credentials are encrypted with `ENCRYPTION_MASTER_KEY`
- Test coverage is critically low (<1%) — see `TEST_COVERAGE.md` for priorities
- Project management: [Linear](https://linear.app/whalesync/team/DEV)

## Additional Resources

- [Main README](/README.md)
- [Connector Development Guide](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md)
- Module-specific docs: `/server/src/*/README.md`
- [GitLab Pipeline Schedules](https://gitlab.com/whalesync/spinner/-/pipeline_schedules)
