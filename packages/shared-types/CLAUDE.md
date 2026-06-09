# shared-types — conventions for shared API types & zod

`@spinner/shared-types` is the **single source of truth for every type that crosses the REST boundary** — request bodies, query params, response shapes, and the data objects they contain. The server, the web client (`/client`), the desktop app (`/scratch-desktop`), and external consumers all import from here.

## The cardinal rule: no shadow types

If you are typing an `axios` call in a frontend, or a `@Body()`/`@Query()`/return type in a server controller, **the type comes from `@spinner/shared-types`.** Never re-declare a contract type locally.

A "shadow type" is a locally-declared interface/type in `/client` or `/scratch-desktop` (or inline in a server controller) that duplicates — or drifts from — a type that is (or should be) shared. Shadow types are the bug this package exists to prevent: they silently drift from the server, so the client compiles against a lie. **Delete them and import the shared type instead.** If the shared type doesn't exist yet, create it here first.

## Naming

| Kind                                                   | Name                                 | Example                                                                |
| ------------------------------------------------------ | ------------------------------------ | ---------------------------------------------------------------------- |
| **Data object** (a thing that exists in the domain)    | the plain domain noun — nothing else | `Workspace`, `DataFolder`, `User`, `ConnectorAccount`, `Job`, `Sync`   |
| **Request DTO** (a validated request body/query)       | `XDto`                               | `CreateWorkspaceDto`, `UpdateSettingsDto`, `WorkspaceListQueryDto`     |
| **Transport wrapper** (exists _only_ for HTTP framing) | `XResponse` / `XRequest`             | `ListWorkspacesResponse = { workspaces: Workspace[]; cursor: string }` |
| **Branded id**                                         | `XId` (in `ids.ts`)                  | `WorkspaceId`, `DataFolderId`                                          |

Rules that follow from the table:

- **A bare data object is NEVER `XResponse` or `XEntity`.** `Workspace`, not `WorkspaceResponse`, not `WorkspaceEntity`. `Response` is reserved for genuine transport envelopes (pagination cursors, multi-resource bundles, `{ jobId }` acknowledgements). If the response body _is_ the data object, the response type _is_ `Workspace`.
- **The real domain word belongs to the shared type.** The server may need a class/factory to build the object, but it must be named `XEntity` (e.g. `WorkspaceEntity`) — it does not get to squat on `Workspace`. See `/server/CLAUDE.md`.
- Match the **user-facing term** when the product has settled on one (the app calls a workbook a "workspace", so the shared type is `Workspace`).

## zod vs plain types — the decision rule

> **Requests get zod. Responses and data objects get plain `interface`/`type`.**

- **Request DTOs (untrusted input that must be validated):** define a **zod schema** plus its inferred type. The server validates against the schema; the client can run the same validation before sending.

  ```ts
  // dto/workspace/create-workspace.dto.ts
  import { z } from 'zod';
  export const createWorkspaceSchema = z.object({ name: z.string().min(1) });
  export type CreateWorkspaceDto = z.infer<typeof createWorkspaceSchema>;
  ```

- **Responses & data objects (the server constructs them; nobody `.parse()`s them):** define a **plain `interface` or `type`.** zod buys you nothing here — there is no untrusted input to validate, only an inferred type, and an `interface` gives that for free without the schema overhead.
  ```ts
  // db/workspace.ts
  export interface Workspace {
    id: WorkspaceId;
    name: string | null;
    createdAt: string; // ISO-8601 — see "fidelity" below
    // ...
  }
  ```
  (The only reason to put a _response_ in zod is if you want nestjs-zod to validate/strip the outgoing payload at runtime via a serializer interceptor — rare; don't reach for it by default.)

## Fidelity: shared types describe the wire, not the DB

The shared type must match **what actually goes over HTTP**, because that's what every client deserializes:

- **Timestamps are ISO-8601 `string`, never `Date`.** `JSON.stringify(new Date())` emits a string; the server entity/factory must emit `.toISOString()` and the shared type must say `string`.
- **Nullable columns are `T | null`.** If the DB/entity can produce `null`, the shared type says so.
- Interfaces tagged `// keep in sync with schema.prisma` must stay accurate — reconcile drift when you touch them.

## Layout

```
src/
├── db/              # persisted data objects: workspace.ts, data-folder.ts, user.ts, ...
├── dto/<resource>/  # request DTOs (zod) + transport wrappers, one folder per resource
├── enums/           # shared enums
├── connector/       # connector metadata, field types, table-view contracts
├── ids.ts           # branded id types
└── index.ts         # re-exports everything (also db/index.ts for the db/ barrel)
```

When you add a file, add its `export * from './...'` to the appropriate barrel (`index.ts`, and `db/index.ts` for `db/`).

## Adding/changing an endpoint contract — checklist

1. **Request body/query** → zod schema + inferred `XDto` in `dto/<resource>/`.
2. **Response** → if it's a data object, an `interface` in `db/`; if it's a transport envelope, an `XResponse` type in `dto/<resource>/`.
3. Re-export from the barrels.
4. **Server**: bridge the request DTO into NestJS and have the response entity/factory produce the shared type — see `/server/CLAUDE.md`.
5. **Clients**: import the shared types in `/client` and `/scratch-desktop`. Delete any local shadow.

## Anti-patterns (do not do these)

- ❌ Declaring a `Workspace`/`Job`/`DataFolder` interface in `client/src/types/...` or `scratch-desktop/src/renderer/src/types/...`. Import the shared one.
- ❌ Naming a data object `XResponse` or `XEntity` in this package.
- ❌ `createdAt: Date` (use `string`).
- ❌ Putting a zod schema in this package for a pure response/data object "for consistency". Use a plain interface.
- ❌ Re-declaring a request DTO in a client because "it's just a couple fields". It will drift.
