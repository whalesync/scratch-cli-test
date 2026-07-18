# CLAUDE.md

Instructions for Claude Code when working in this repository. Subdirectory CLAUDE.md files contain additional rules scoped to their directories — always read them before working in those areas.

## Critical Rules

- **Always use `yarn`**, never `npm`. This applies to installs, running scripts, and adding dependencies.
- **Run `nvm use` only if you hit a Node.js version error.** Do NOT prefix every command with `nvm use`.
- **Always run commands from the repo root** using Turborepo (see [Development Commands](#development-commands)).
- **Always run `yarn build` and `yarn lint` from the repo root** after completing a series of code changes to verify nothing is broken. Format your changes before committing (e.g. `yarn prettier:check` / `--write` in the affected package) — CI runs `prettier:check` and there is no pre-commit hook to do it for you.
- **Do not ignore pre-existing test or lint errors.** If `yarn test` or `yarn lint` fails on code you did not change, stop and ask the user how to proceed rather than silently ignoring the failures.
- **QA desktop-app (client) changes with real UI before committing.** When you change the desktop app (`/scratch-desktop`), suggest the user run `/qa-desktop-app` to exercise the change through real UI interaction against the live test backend before committing, and optionally add a Playwright (`_electron`) test to cover the new behavior.
- Look for **Skills** to help with specific tasks in the `.claude/skills` folder

## Project Overview

**Scratch** (codename: "Spinner") is a content management system that syncs data between external services (e.g. Airtable, Webflow) and a git-based storage layer. It provides knowledge workers a VS Code-like workspace for managing content across services.

## Product Principles

Foundational invariants of the product. Hold to these unless a maintainer explicitly says otherwise.

### The Connector Prime Directive: preserve external data fidelity

**We never reshape, rename, or normalize the data on the way in — a record's own structure stays exactly as the API returned it. If the raw shape is awkward to display or edit, adapt the view/schema layer to the data; never transform the data to fit the UI.** This is the **Connector Prime Directive**, and it beats convenience every time. It is what gives us round-trip fidelity (what we publish back is the shape the service expects), keeps debugging honest (the file on disk is exactly what the API sent), and keeps git history meaningful.

**The only two exceptions — and this is the entire list** — are stripping transport wrappers (pagination cursors, `hasMore` flags, page counts) and hydrating nested stub references in place. Both stay within the _spirit_ of the Directive because neither touches a record's own structure: transport wrappers are the envelope around the data, not the data; hydration only fills a stub the API itself points to, in place, without renaming a key or changing a container. **Nothing else qualifies** — and note that a transform reversing cleanly on publish does _not_ make it an exception, because the Directive governs what sits on disk, not only what we ship back. The canonical trap is reshaping an array into a keyed object so its elements become editable columns (e.g. `custom_fields: [{ id, value }]` → `{ cf_<id>: value }`); when the view layer can't edit the raw shape, the fix is to extend the view/schema/path layer or leave the value non-editable — **never to reshape the data.** **Any stored record that deviates from the Directive is a bug**, not an accepted variation. A few connectors currently violate it (they slipped in unintentionally) — those are open bugs to fix, never precedent to copy. Full rules, the litmus test, and the list of tempting-but-forbidden transforms: [Connector Development Guide → The Connector Prime Directive](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md).

### Prefer files for user data

User data lives as **files in a git repository**, not as rows in a database. Each record is a JSON file, and the metadata that describes it — the table's schema — sits alongside it as a file too. Reach for the filesystem first; keep the database for things that aren't user content (job state, indexes, audit logs, encrypted credentials). Storing data this way is what gives us two properties the product leans on: a **clean round-trip between a user's local machine and the web** — they can `git clone` a workbook, edit it locally, and push it back through the same standard git plumbing the app itself uses — and **full version history**, so every record and schema change is diffable, attributable, and revertible through git.

### Discover schemas dynamically; don't hardcode

Read field definitions from the service's own metadata endpoints instead of baking them into connector code. When a user adds a column in Airtable or a property in Notion, it should **appear in Scratch automatically, with no connector change**. Hardcode a schema only when the API offers no introspection at all (e.g. WordPress post types). The same instinct applies beyond connectors: derive structure from the data and the service rather than encoding assumptions we then have to maintain by hand.

### Keep connector knowledge out of the frontends

The frontends — **Scratch web** (`/client`), **Scratch desktop** (`/scratch-desktop`), and the **`scratchmd` CLI** (`/scratch-git-2/src/cli`) — render and edit user data generically and must contain **no connector-specific knowledge**. They never branch on a service (no `if (notion) …`), never reach into a connector's value shape (e.g. Notion's rich-text `plain_text` spans), and never hardcode how a particular service formats a field. Everything connector-specific is computed on the **server** and handed to the frontend declaratively through the generic contracts they already consume — the JSON schema and the table view (column types, subfields, foreign-key options, and `displayTransformer`). When a connector needs a value reshaped for display, it emits a declarative instruction the frontend runs through a **generic engine** (e.g. a column's `displayTransformer` flattening a Notion rich-text array to plain text); it does not teach the frontend about the connector. This keeps each connector's quirks in one place, lets a new connector light up across all three frontends with no frontend change, and keeps the frontends small and uniform.

### Build operations as composable, independent systems

Each operation in the data pipeline — **pulling** records from a service, **syncing** records (copying and transforming values from one folder to another), **publishing** records back, **building a publish plan**, running **validators**, and the like — is a self-contained system with explicit inputs and outputs. Any one of them can be run and verified on its own, without standing up the rest of the pipeline around it. Operations **compose** into larger flows but stay decoupled: a step reads well-defined state and writes well-defined state, so it can be exercised, tested, and debugged in isolation. When adding or changing behavior, **keep the new logic inside the operation it belongs to (or a new operation) rather than threading it across steps** — and preserve the property that the operation stays runnable and checkable by itself.

### Make operations idempotent and resumable

Every long-running operation — a pull, a sync, a publish — must be safe to run again. Re-running **converges to the same result** instead of duplicating or corrupting data: pull commits are idempotent, incremental watermarks are captured _before_ the first API call so anything modified mid-run is simply re-pulled next time, and jobs checkpoint their progress so a stalled run resumes where it stopped rather than starting over. Assume any job can crash and restart at any point, and design so that restart is always correct and never destructive.

### Keep the user in control of what gets published

Edits never reach the external service on their own. Every record field moves through three explicit states — **published** (what's live in the service), **approved** (staged for publish), and **local** (the working edit on disk) — and only a deliberate `accept` promotes a local edit to approved, only `publish` ships approved changes live. `reject` and `discard` walk an edit back down that same ladder. **Nothing is published that the user didn't explicitly approve**, and every approval stays reversible until it ships. When you add a review-style action, respect the ladder — e.g. a "reject" may touch only the working tree, never the approved set.

### Default to non-destructive, reversible actions

Prefer operations that can be undone and that never throw away data the user didn't choose to lose. Walking back a review step restores a saved value rather than guessing; an accepted delete or create can be reverted; and when an operation hits an ambiguous state, it **warns and skips rather than destroying** the record (e.g. it never overwrites the match key that identifies a synced record). Writes are atomic — temp file → fsync → rename — so a crash mid-write can't leave a half-written record.

### Surface failures; never silently succeed

When something can't be done, say so — don't drop the work and report success. We **don't silently strip a user's edits** to read-only fields and pretend the write happened; we send the data and let the service reject it so the user understands what occurred. We **fail fast at the boundary** with a clear message (e.g. validating a user-supplied column against the schema up front) rather than letting an opaque error surface deep inside a job. Graceful degradation means _warn and skip_, never _swallow and lie_.

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
- **GCP projects:** The Scratch infrastructure lives in two GCP projects — `spv1eu-test` (test) and `spv1eu-production` (production). Use these for `gcloud` commands such as Cloud Logging queries. **Always pass `--billing-project=<the target project>` in addition to `--project`** — the read-only service account's quota/billing defaults to its own home project (where APIs like Cloud Logging aren't enabled), so without it you'll hit a misleading `SERVICE_DISABLED` error pointing at the wrong project. Example: `gcloud logging read '<filter>' --project=spv1eu-production --billing-project=spv1eu-production`. (The `connect_to_gcp_db_readonly.sh` script derives the same names as `spv1eu-${env}`.)
- **Inspecting a live database (read-only):** It is OK to connect to the prod (or test) database to debug user issues or investigate live data using `terraform/tools/connect_to_gcp_db_readonly.sh <env>` (`env` = `test`|`production`). It opens an IAP SSH tunnel and connects as the `readonly` Postgres user against the `scratchpad` database with read-only guardrails (`default_transaction_read_only=on`, `statement_timeout=30s`). Pass a SQL string as the second argument for a one-shot query, or omit it for an interactive `psql` shell. Requires an authenticated `gcloud` CLI. This is read-only only — never use a read-write DB connection against prod.
- **Inspecting the scratch-git VM (read-only):** It is OK to get a restricted shell on the `scratch-git` GCE VM to inspect it — view Docker state/logs, check disk usage, and read repos — using `terraform/tools/connect_to_git_service_ssh.sh <env>` (`env` = `test`|`production`). It opens an interactive IAP SSH session; the per-dev "gcp-ro" read-only SAs (`role_readonly_sa@whalesync.com` — what your laptop/agent uses by default) land in the restricted tier (OS Login, no sudo) and may ONLY run the four read-only wrappers: `sudo gitops-ps`, `sudo gitops-logs <container> [lines]`, `sudo gitops-disk`, and `sudo gitops-git <org_../wkb_../coa_..> <subcommand> [args]`. Any mutation/cleanup (docker prune, disk-space fixes, `rm`, `docker exec`, repo writes) is **break-glass** — it needs a `role_operations@whalesync.com` admin (root) SSH, per the recovery runbooks. Requires an authenticated `gcloud` CLI. (`connect_to_git_service.sh` still port-forwards 3100 for talking to the REST API — that's unchanged.)
- Project management: [Linear](https://linear.app/whalesync/team/DEV)
- When adding new data resources to a Workbook (database tables, git repos, files on disk, etc.), ensure they are cleaned up in `WorkbookService.delete` (`server/src/workbook/workbook.service.ts`). If the new table has a foreign key to Workbook with `onDelete: Cascade`, Prisma handles it automatically. Otherwise, add explicit deletion before the workbook record is deleted.
- **When a connector change goes in, keep its docs current:** update the affected connector's `STATE.md` (`server/src/remote-service/connectors/library/<connector>/STATE.md`) and the cross-connector table in [`connector-build/existing-connectors.md`](/connector-build/existing-connectors.md) so support/auth/test-coverage cells (OAuth/Creds/CS/IP/Visible/IT) reflect the change.

## Additional Resources

- [Main README](/README.md)
- [Connector Development Guide](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md)
- [scratchmd CLI: Review Model](/scratch-git-2/docs/REVIEW_MODEL.md) — accept / reject / discard semantics and the published/approved/local state model
- [scratchmd CLI: Repo Structures](/scratch-git-2/docs/REPO_STRUCTURES.md) — CLI and service on-disk layouts
- [Pseudo-references (`@/…`)](/docs/pseudo-refs.md) — canonical format and resolution rules for `@/` record references in link fields (workspace-absolute, connection folder first)
- Module-specific docs: `/server/src/*/README.md`
- [GitLab Pipeline Schedules](https://gitlab.com/whalesync/spinner/-/pipeline_schedules)

@.claude/.local/CLAUDE.md
