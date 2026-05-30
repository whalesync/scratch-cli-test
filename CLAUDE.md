# CLAUDE.md

Instructions for Claude Code when working in this repository. Subdirectory CLAUDE.md files contain additional rules scoped to their directories — always read them before working in those areas.

## Critical Rules

- **Always use `yarn`**, never `npm`. This applies to installs, running scripts, and adding dependencies.
- **Run `nvm use` only if you hit a Node.js version error.** Do NOT prefix every command with `nvm use`.
- **Always run commands from the repo root** using Turborepo (see [Development Commands](#development-commands)).
- **Always run `yarn build` and `yarn lint` from the repo root** after completing a series of code changes to verify nothing is broken. Do NOT run `yarn format` — formatting is handled automatically by a pre-commit hook.
- **Do not ignore pre-existing test or lint errors.** If `yarn test` or `yarn lint` fails on code you did not change, stop and ask the user how to proceed rather than silently ignoring the failures.
- Look for **Skills** to help with specific tasks in the `.claude/skills` folder

## Project Overview

**Scratch** (codename: "Spinner") is a content management system that syncs data between external services (e.g. Airtable, Webflow) and a git-based storage layer. It provides knowledge workers a VS Code-like workspace for managing content across services.

## Monorepo Structure

This is a Yarn workspaces monorepo managed by Turborepo.

| Package       | Path                     | Description                                                                 |
| ------------- | ------------------------ | --------------------------------------------------------------------------- |
| Client        | `/client`                | Next.js web app (port 3000)                                                 |
| Server        | `/server`                | NestJS API server (port 3010)                                               |
| scratch-git-2 | `/scratch-git-2`         | Rust git microservice (ports 3100 API + 3101 HTTP backend)                  |
| scratchmd CLI | `/scratch-git-2/src/cli` | Rust CLI (`scratchmd` command) for interacting with Scratch and local files |

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

Always run these from the repo root — do not `cd` into subdirectories to run build, test, or lint.

```bash
yarn dev              # Start all dev servers (client, server, shared-types watch)
yarn build            # Build all packages with caching and dependency ordering
yarn migrate          # Run database migrations
yarn lint             # Lint all packages
yarn test             # Run tests across all packages
yarn test:integration # Run integration tests across all packages
```

## Code Conventions

### Code Style

- Prettier with organize-imports plugin
- Single quotes, semicolons, 120-char line width, trailing commas everywhere
- `kebab-case` for filenames: `user-service.ts`
- `PascalCase` for classes: `UserService`
- Files end with a newline
- Use `assertUnreachable` in `default` cases of `switch` statements over union/enum types to ensure exhaustive handling at compile time (`client/src/utils/helpers.ts`, `server/src/utils/helpers.ts`)

### Self-documenting names

**Prefer maximum self-documenting names for variables and functions.** Long, fully explicit identifiers beat concise or idiomatic short ones — even when the longer form runs ~30–40 characters or causes lines to wrap.

This matters more for AI-written code than for human-written code. Humans and AI agents often discuss this code in conversation, in audit docs, in review comments, and in plans — without anyone actually opening the file. A variable named `main_map` is meaningless when listed in isolation; `file_path_to_contents_map_in_main_branch` tells you exactly what it holds. The reader should be able to understand a name from the name alone, not from chasing types and call sites.

Apply this everywhere:

- **Variables**: `file_path_to_contents_map_in_main_branch` over `main_map`. `approved_object_at_path_if_any` over `approved_obj_opt`. `record_paths_with_byte_differences_against_main` over `ambiguous`.
- **Functions**: avoid historical-scar suffixes (`_fast`, `_for_entry_point`, `_single_repo`, `_full_scan`, `_locally`) when they don't describe behaviour. Use the full action: `read_main_branch_contents_filtered_by_path` over `read_main_tree_for_entry_point_filtered`. `revert_field_edit_to_approved_value` over `reject_field` when the verb is ambiguous.
- **Type-redundant suffixes are fine.** Keep `_map`, `_list`, `_set`, `_counter` when they help the call site read as English. The type signature already says it; the call site doesn't.
- **Local variables** in non-trivial functions get the same treatment as struct fields and module-level identifiers. A 20-line function with terse locals is just as opaque as one with terse parameters.

The cost — wrapped lines, more characters to read — is a real cost but a small one. The benefit — being able to discuss, review, audit, and refactor code without anyone needing to open the file first — compounds across every conversation and every PR.

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

When creating or modifying REST API endpoints, update all consumers:

- React client (`client/src/lib/api/`)
- Rust CLI (`scratch-git-2/src/cli/`)

#### Real-time Updates

Redis pub/sub → WebSocket gateway → connected clients. Multiple server instances coordinate via Redis.

## Important Notes

- React Strict Mode runs components twice in dev (affects debugging)
- Feature flags: OpenFeature + PostHog — do NOT enable "Persist flag across authentication steps" (causes errors)
- Connection credentials are encrypted with `ENCRYPTION_MASTER_KEY`
- Project management: [Linear](https://linear.app/whalesync/team/DEV)
- When adding new data resources to a Workbook (database tables, git repos, files on disk, etc.), ensure they are cleaned up in `WorkbookService.delete` (`server/src/workbook/workbook.service.ts`). If the new table has a foreign key to Workbook with `onDelete: Cascade`, Prisma handles it automatically. Otherwise, add explicit deletion before the workbook record is deleted.

## Additional Resources

- [Main README](/README.md)
- [Connector Development Guide](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md)
- [scratchmd CLI: Review Model](/scratch-git-2/docs/REVIEW_MODEL.md) — accept / reject / discard semantics and the published/approved/local state model
- [scratchmd CLI: Repo Structures](/scratch-git-2/docs/REPO_STRUCTURES.md) — CLI and service on-disk layouts
- Module-specific docs: `/server/src/*/README.md`
- [GitLab Pipeline Schedules](https://gitlab.com/whalesync/spinner/-/pipeline_schedules)

@.claude/.local/CLAUDE.md
