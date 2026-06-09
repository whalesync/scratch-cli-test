# Code style

- Do not use `as any` to solve type issues
- Do not use console.log, etc. to log. Instead, use WSLogger.info|warn|error.
- Do not use non-null assertions (`x!`) in production code — the `@typescript-eslint/no-non-null-assertion` rule is enabled and will fail lint. Use a real guard (`if (!x) throw …` / early return), narrow with a type predicate, or restructure to capture the value during the existence check. Non-null assertions are only permitted in unit/integration test files, and even there must be paired with an `// eslint-disable-next-line @typescript-eslint/no-non-null-assertion` comment.

# API types & zod bridging

Every REST request/response type lives in `@spinner/shared-types` — read **[`/packages/shared-types/CLAUDE.md`](../packages/shared-types/CLAUDE.md)** for the naming and zod-vs-plain-type rules. This section is how those rules attach to NestJS.

**Request DTOs (zod → NestJS).** The validated _schema_ lives in shared-types; the server adds a thin DTO class that bridges it into Nest:

```ts
// server/src/<resource>/dto/create-workspace.dto.ts
import { createWorkspaceSchema } from '@spinner/shared-types';
import { createZodDto } from 'nestjs-zod';
export class CreateWorkspaceDto extends createZodDto(createWorkspaceSchema) {}
```

Use it as `@Body() dto: CreateWorkspaceDto` (or `@Query() q: WorkspaceListQueryDto`). The global `ZodValidationPipe` (registered in `main.ts`) validates any `ZodDto` metatype against its schema and **passes every non-zod DTO through untouched**, so zod and the existing `class-validator` `ValidationPipe` coexist — migrate endpoints one at a time. `ZodValidationException` is mapped to the standard error envelope by `ZodValidationExceptionFilter` (registered in `main.ts` _before_ `BadRequestExceptionFilter`, since it subclasses it). The generated DTO class is derived entirely from the shared schema, so it can't drift.

**Responses (shared type ← server factory).** A controller returns the **shared data type** (`Promise<Workspace[]>`), never a server-only class named after the domain word. Build the object with a server-only factory whose name carries the `Entity` suffix:

```ts
// server/src/<resource>/entities/workspace.entity.ts
export const WorkspaceEntity = {
  from(row: WorkspaceCluster.Workbook /* side-loaded maps */): Workspace {
    return { id: row.id as WorkspaceId, createdAt: row.createdAt.toISOString() /* ... */ };
  },
};
```

- Prefer a **factory** (`WorkspaceEntity.from(...)`) returning the shared interface. Use a **class** (`class WorkspaceEntity implements Workspace`) only when a class is genuinely required (e.g. `ClassSerializerInterceptor` with `class-transformer` decorators).
- **Never name the construction vehicle `Workspace`** — that's the shared type. It's `WorkspaceEntity`.
- Emit timestamps as ISO strings (`.toISOString()`) and nullables as `T | null` so the object matches the shared (wire) type exactly.

# Workflow

- Run all the following commands in the root of the repo
- Be sure to test the build with `yarn run build` when you’re done making a series of code changes
- Regularly run the linter with `yarn run lint` for code changes
- Regularly run `yarn run typecheck` after changes to unit tests, integration tests and generating code for prisma schemas
- Prefer running single tests, and not the whole test suite, for performance
- Run the integration tests with `yarn run test:integration` when you're done making a series of code changes.

# Analytics and Tracking

The server has two channels for tracking user activities: Posthog and Audit Logging. Most user activities will require writing events to both channels.

## Posthog

Posthog provides standard analytics tracking activities and external aggregation and dashboards. These events are pushed to an external service vial the Posthog SDK.

- Tracked through the PosthogService
- Every event will take an Actor object to identify the user that took the action
- Posthog events are only used internally and never show to the user
- Tracking functions in PosthogService should NEVER throw errors or otherwise break the caller

## Audit Logging

Audit logs are persistent tracking of updates to a user or organizations data entities in Scratch. Audit logs are stored in the primary database.

- Tracked through the AuditLogService
- Every event will take an Actor object to identify the user that took the action along with the organization they belong to
- Audit log messages should be human-readable and user-friendly
- Audit logs will be visible to the user and can be exported
- Audit logs should be associated with an entity in the system and an eventType describing the interaction with that entity.

## What to track

- creating, updating or deleting core entities in the Scratch project that associated with the User, Organization or Workbook
  - i.e. creating a Workbook, deleting a Data Folder, modify a record file
- triggering asynchronous jobs related to a core entit
  - starting a pull job for a data source
  - downloading files from a data folder
- Changing permissions on an entity
- Adding or removing user from an organization
- Interactions through the `scratchmd` CLI (`scratch-git-2/src/cli/`)
