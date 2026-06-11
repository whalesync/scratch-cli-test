# Create-Schema API Contract for the Scratch Server

- **Status:** In Progress
- **Created:** 2026-06-10
- **Author:** Chris Hoefgen
- **Linear:** [DEV-10378](https://linear.app/whalesync/issue/DEV-10378)

> Design + implementation plan. **This pass defines the API contract** — REST
> endpoints, the generic schema-description types, and validation — plus a clean
> connector seam. Connector execution (the actual create-table/field calls) is a
> later pass. Two endpoints (`plan-from-folder`, `validate`) ship fully working now;
> `tables`/`fields` return `not_supported` until a connector opts in.
>
> **As built (reconciled with the implementation):** request DTOs are **zod
> schemas** validated by the repo's global `ZodValidationPipe` (`nestjs-zod`) — the
> logical field-type union is a `z.discriminatedUnion` with `superRefine` for the
> intra-request rules, not the hand-written normalizer this doc originally proposed
> (the repo had migrated to zod). The endpoints are also exposed through the shared
> **`@spinner/shared-types/api-client`** as `client.schema.*`. See the
> **As-built notes** section at the end for the concrete file list and what remains
> deferred.

## Context

Scratch can read schemas from external services and publish record-level
creates/updates/deletes, but it has **no way to create new tables or fields on a
remote data source**. A user who wants a fresh Airtable table, a new Notion
database, or an extra column has to go do it in the service's own UI first, then
add it to their workbook.

Whalesync solved the equivalent problem years ago with
`RestGenerateSchemaController` + `ExternalGenerateSchemaService`: a generic,
service-agnostic way to describe tables and fields, validate them, and hand them
to a connector that performs the real API calls. That prior art is the
inspiration here, but the Scratch design must fit Scratch's architecture
(connector abstraction, file-backed folders, the published/approved/local model)
and product principles.

**This pass delivers the API contract only** — the generic schema-description
types, the REST endpoints, and the validation — plus a clean, well-scoped
connector seam. **No connector implementation** lands now (the connector side is
being investigated separately). Because no connector can yet execute a create,
the contract is made independently testable through a **dry-run `validate`
endpoint** and a stubbed connector in tests. The intended outcome is a stable,
reviewable interface that the later connector work and the frontends can build
against without churn.

### Scope decisions (confirmed with the user)

1. **API contract first** — REST endpoints + validation. Connector execution is a
   later pass.
2. **Logical type union** for field descriptions — a small, explicit
   discriminated union the server validates and connectors later map to native
   types. Keeps connector knowledge off the wire (Whalesync's proven model,
   Scratch-flavored).
3. **`materializeLocally` is a per-request option** — when set, after the remote
   table exists the operation also creates the local `DataFolder` + `schema.json`
   by **reusing `DataFolderService.createFolder`** (no duplicated logic).
4. **Design-only for connectors** — no Airtable/Notion/Postgres implementation in
   this pass.

---

## Key grounding (verified against source)

- **Connector base class** `server/src/remote-service/connectors/connector.ts`
  gates capabilities two ways, both reused here: boolean methods with a safe
  default (`supportsFilters(): boolean { return false }`) and **optional** methods
  whose default impl throws (`uploadFile`, `searchTables`). Record writes already
  exist (`createRecords`/`updateRecords`/`deleteRecords`); there is **no**
  table/field create method — that is the new seam.
- **zod request DTOs (as built).** `main.ts` registers both `new ValidationPipe()`
  (class-validator) **and** `new ZodValidationPipe()` (`nestjs-zod`); the zod pipe
  validates any `createZodDto(schema)` metatype against its schema and passes
  non-zod bodies through. So the deep field-type union is validated by a
  **`z.discriminatedUnion('kind', …)`** with **`superRefine`** for the intra-request
  rules (ref/name uniqueness, single `isPrimary`, FK ref resolvability) — no
  hand-written normalizer or class-validator discriminator needed. (This supersedes
  the doc's original class-validator plan; the repo migrated to zod in the interim.)
- **`DataFolderService` is exported from `WorkbookModule`** and
  `createFolder(dto, actor, runContext)` (`data-folder.service.ts:247`) already
  does the full materialize flow: assert writable workbook → load connector
  account → `fetchJsonTableSpec({ wsId, remoteId })` → unique path → create DB row
  → write `schema.json` + default view to git. The new module imports
  `WorkbookModule` and reuses this for `materializeLocally`.
- **Schema/types**: `BaseJsonTableSpec` (`connectors/types.ts`) holds a TypeBox
  `TSchema` annotated with `x-scratch-*` keys; `EntityId = { wsId: string;
  remoteId: string[] }`; a folder's `tableId` is the `string[]` remoteId. FK on
  the read side is `X_SCRATCH_FOREIGN_KEY_OPTIONS → { linkedTableId }` — the
  create-side `foreignKey` variant mirrors this vocabulary.
- **DTO convention (as built)**: per `packages/shared-types/CLAUDE.md`, **requests
  are zod schemas** (`export const xSchema = z.object(...)` + `export type XDto =
  z.infer<typeof xSchema>`) in `dto/<resource>/`; the server adds a thin
  `class XDto extends createZodDto(xSchema) {}` bridge. **Responses/data objects are
  plain `interface`s** (`XResponse`). Frontends consume endpoints through the shared
  `@spinner/shared-types/api-client` resource namespaces (one resource file per
  domain) — never hand-rolled axios.
- **Permissions / conventions**: `workbookService.assertWritableWorkbook(actor,
  workbookId)`; `userToActor(req.user)`; `WSLogger` (not console); no `as any`; no
  prod non-null assertions; `assertUnreachable` in switch defaults; audit-log +
  PostHog on core-entity mutations (`server/CLAUDE.md`).

---

## The design

### 1. Logical schema-description types (new shared-types)

> **As built:** these live in `packages/shared-types/src/dto/schema/` —
> `create-schema.dto.ts` holds the **zod schemas** for the request bodies
> (`createSchemaTablesSchema`, `createSchemaFieldsSchema`, `generateCreatePlanSchema`,
> plus the `createFieldTypeSchema` discriminated union) and their inferred types;
> `create-schema-responses.dto.ts` holds the plain response/data interfaces and
> `SchemaCreationCapabilities`. The request-type names below shown as
> `…Request` are, in code, the zod-inferred **`…Dto`** types (`CreateSchemaTablesDto`,
> `CreateSchemaFieldsDto`, `GenerateCreatePlanDto`). The shapes are otherwise as
> drawn here.

```ts
/** Logical field types the server validates and connectors map to native types. */
export type CreateFieldType =
  | { kind: 'text' }
  | { kind: 'longText' }
  | { kind: 'number'; precision?: number; format?: 'plain' | 'integer' | 'decimal' | 'percent' }
  | { kind: 'boolean' }
  | { kind: 'date'; includesTime?: boolean }
  | { kind: 'select'; options: CreateChoiceOption[] }
  | { kind: 'multiSelect'; options: CreateChoiceOption[] }
  | { kind: 'url' }
  | { kind: 'email' }
  | { kind: 'phone' }
  | { kind: 'currency'; currencyCode: string; precision?: number }   // ISO 4217
  | { kind: 'foreignKey'; target: ForeignKeyTarget; allowMultiple?: boolean };

export type CreateFieldKind = CreateFieldType['kind'];

export interface CreateChoiceOption { name: string; color?: string }

/** A foreignKey points at EITHER an existing remote table OR a sibling table
 *  created in the same request (by its `ref`). Exactly one branch is set. */
export type ForeignKeyTarget =
  | { existingRemoteTableId: string[] }
  | { ref: string };

export interface CreateFieldSpec {
  name: string;
  fieldType: CreateFieldType;
  description?: string;
  required?: boolean;          // best-effort; connector may not support it
  /** Marks this field as the table's primary/title field. **At most one** field
   *  per table may set it — validation rejects multiple. Connectors with a
   *  mandatory title field (Notion, Webflow) use it; if none is set the connector
   *  picks or injects its own default. */
  isPrimary?: boolean;
}

export interface CreateTableSpec {
  name: string;
  /** The table's fields, created together with the table. A connector whose API
   *  can create a table + its fields in ONE call does so; one that can't creates
   *  the table then adds fields. The server does NOT mandate the split — the
   *  connector decides internally. The primary/title field is designated by
   *  `isPrimary` on one of these fields (see CreateFieldSpec). */
  fields: CreateFieldSpec[];
  ref: string;                 // caller-assigned, unique-per-request; FK refs + result correlation
}
```

Request / response (transport shapes the DTO envelope mirrors):

```ts
export interface CreateSchemaTablesRequest {
  connectorAccountId: string;
  remoteParentId?: string[];     // remote base/parent (Airtable base, Notion parent, PG schema) — connector-interpreted
  tables: CreateTableSpec[];
  materializeLocally?: boolean;  // also create the local DataFolder + schema.json
  parentFolderId?: string;       // where to nest materialized folders
}

export interface CreateSchemaFieldsRequest {
  connectorAccountId: string;
  remoteTableId: string[];       // existing table to add fields to
  fields: CreateFieldSpec[];
  refreshLocalSchema?: boolean;  // re-fetch schema.json if the table is materialized locally
}

export interface CreateFieldResult {
  name: string;
  status: 'created' | 'failed' | 'skipped';
  remoteFieldId?: string;
  /** True when the connector auto-added this field to satisfy a minimum
   *  requirement (e.g. a Notion/Webflow title field the request omitted). */
  autoAdded?: boolean;
  error?: string;
}
export interface CreateTableResult {
  ref: string; name: string;
  status: 'created' | 'failed' | 'partial' | 'skipped';
  remoteTableId?: string[];
  fields: CreateFieldResult[];
  dataFolderId?: string;         // set when materializeLocally succeeded
  materializeError?: string;     // remote table created but local folder failed
  error?: string;
}
export type CreateSchemaStatus = 'ok' | 'partial' | 'failed' | 'not_supported';
export interface CreateSchemaTablesResponse {
  status: CreateSchemaStatus;
  tables: CreateTableResult[];
  unsupported?: { service: string; message: string };  // only when status === 'not_supported'
}
export interface CreateSchemaFieldsResponse {
  status: CreateSchemaStatus;
  remoteTableId: string[];
  fields: CreateFieldResult[];
  unsupported?: { service: string; message: string };
}

// Dry-run (fully functional THIS pass)
export interface ValidateSchemaIssue { path: string; code: string; message: string }
export interface ValidateSchemaResponse {
  valid: boolean;
  issues: ValidateSchemaIssue[];
  schemaCreationSupported: boolean;  // echo of connector capability
  service: string;
}

// Generate a create-table plan FROM one or more existing source DataFolders,
// targeting a destination connector. Read-only: produces an editable plan,
// executes nothing. Multi-folder requests are a FIRST-CLASS, common case — they
// let foreign keys between the source tables resolve to in-plan {ref}s.
export interface GenerateCreatePlanRequest {
  sources: GenerateCreatePlanSource[];     // one or more source folders → a (multi-)table plan
  destinationConnectorAccountId: string;   // connector the table(s) would be created on
  remoteParentId?: string[];               // where on the destination (base/parent)
  /** Optional: map a source `linkedTableId` to an ALREADY-EXISTING destination
   *  table so an FK pointing outside the source set can still resolve to
   *  `{ existingRemoteTableId }`. FKs that resolve to neither an in-plan table
   *  nor a mapping entry are flagged `unsupported` (not downgraded to text). */
  linkedTableMappings?: { sourceLinkedTableId: string; destinationRemoteTableId: string[] }[];
}
export interface GenerateCreatePlanSource {
  dataFolderId: string;                    // existing folder whose schema is a template
  newTableName?: string;                   // defaults to the source table/folder name
}
export interface FieldMappingNote {
  sourceDataFolderId: string;   // which source table this field came from
  sourceFieldPath: string;
  fieldName: string;
  status: 'mapped' | 'downgraded' | 'unsupported';
  mappedKind?: CreateFieldKind;
  message?: string;   // e.g. "formula → text (computed fields can't be created)"
}
export interface GenerateCreatePlanResponse {
  plan: CreateSchemaTablesRequest;   // one CreateTableSpec per source; ready to review/edit, then POST to /schema/tables
  notes: FieldMappingNote[];         // per-field mapping outcome — nothing dropped silently
  destinationSupportsCreation: boolean;
}
```

### 2. Foreign keys / cross-table refs

`foreignKey.target` is a two-branch union: an existing remote table id, or a
sibling table's `ref` in the same request. **Multi-table plans are a common case**
(decision #11), so cross-table `{ref}` FKs are a primary path, not an edge case.
Validation (no remote calls this pass): build the request's `ref` set, enforce
uniqueness; for each FK, require exactly one branch (`FK_TARGET_AMBIGUOUS`
otherwise) and, for `{ref}`, require the ref to exist (`FK_UNKNOWN_REF`).
`{existingRemoteTableId}` is **structurally checked only** this pass — proving the
remote table actually exists needs a connector fetch and is **deferred to the
connector pass** (accepted, decision #4).

**Boundary: the server owns cross-table ordering; the connector owns
table+field creation.** A `foreignKey` field that points at a sibling table being
created in the same request needs that table's remote id, which only the server
knows (it coordinates the multiple `createTable` calls and collects ids). So the
**server topologically sorts tables by FK dependency** and resolves each `{ref}`
target to a concrete remote id *before* handing the table to the connector. The
connector then receives a table spec with **all** its fields (FK targets already
resolved to remote ids) and creates the table + fields however its API allows —
ideally one call. The only fields the server defers are those in a **cycle**
(A→B and B→A): such tables are created with their non-cyclic fields first, then the
cyclic FK fields are added via `createFields` once both tables exist.
Self-referential FKs need no deferral. We define this ordering/resolution as pure
normalization now (testable); we do **not** execute it this pass.

### 3. REST endpoints (one controller, workbook-scoped, synchronous)

Base mirrors `publish-plan.controller.ts` (`workbook/:workbookId/...`) so
permissions are uniform. `workbookId` in the path; everything else in the body.

```
POST /workbook/:workbookId/schema/plan-from-folder → GenerateCreatePlanResponse  (read-only; derives a plan from a source folder)
POST /workbook/:workbookId/schema/validate         → ValidateSchemaResponse      (never touches remote)
POST /workbook/:workbookId/schema/tables            → CreateSchemaTablesResponse
POST /workbook/:workbookId/schema/fields             → CreateSchemaFieldsResponse
```

**`plan-from-folder`** takes **one or more** existing source `DataFolder`s as the
template and a destination connector account, and returns an **editable**
`CreateSchemaTablesRequest` (one `CreateTableSpec` per source folder) plus per-field
mapping notes. It is **fully functional this pass** because it only reads:
- each source schema via `DataFolderService.getStoredSchema(dataFolderId, actor)`,
  walked into generic `SchemaField[]` by the existing
  `extractSchemaFields(schema)` (`server/src/utils/schema-helpers.ts`), plus each
  source folder's `TableView` (`views/default.json`) for `TablePropertyType` hints;
- the destination connector's `getSchemaCreationCapabilities()` (when implemented) to
  flag unsupported kinds and the required primary field.

A pure `inferLogicalFieldType(schemaField, tableViewCol)` maps **generic** signals
only — JSON-Schema primitive, `TablePropertyType`, and generic `x-scratch-*`
annotations (FK, max-length, asset) — to a `CreateFieldType`, so **no per-connector
native-type knowledge** enters the server: e.g. `checkbox`→`boolean`, `number`→
`number`, `date`→`date`, `url`→`url`, `richtext`→`longText`, an enum-union→`select`,
`currency`/`email`/`phone` when the annotations make them unambiguous, and anything
read-only/computed/unmappable **→ downgraded to `text`** with a note (decision #12).
The field at the source's `titleColumnRemoteId` is marked `isPrimary: true` on the
generated table. Every field gets a `mapped` / `downgraded` / `unsupported` note —
nothing is dropped silently.

**Foreign keys (decision #11):** a source FK field carries
`X_SCRATCH_FOREIGN_KEY_OPTIONS.linkedTableId` (the *source* table id). The generator
assigns each source folder a `ref` and resolves an FK to `{ ref }` when its
`linkedTableId` matches **another source folder in the same request** — the reason
multi-table plans are the common path. An FK whose linked table is **not** in the
request resolves to `{ existingRemoteTableId }` **only** via a
`linkedTableMappings` entry (the linked table already exists on the destination);
otherwise the FK field is flagged **`unsupported`** and omitted from the plan (the
user re-runs including the linked folder). FKs are **never** downgraded to text.

The destination's create support is **not** required to generate a plan (the response
carries `destinationSupportsCreation` so the caller knows whether a later `/tables`
call would return `not_supported`).

- **Separate** `tables` vs `fields` endpoints (genuinely different inputs), plus
  the dedicated `validate` dry-run — which makes the **entire contract testable in
  this pass** with no connector executing creates.
- **Synchronous now, BullMQ-ready (decision #8).** Controller actions return the
  result directly (like `DataFolderController.create`); one table + a few fields is a
  small bounded number of calls. **Structure the service so the
  validate→normalize→dispatch→materialize core is a single standalone callable**
  (e.g. `executeCreatePlan(plan, actor, runContext)`) that a future BullMQ job
  handler can wrap **unchanged** — no controller-coupled state, accept an
  `AbortSignal`, and shape the response as the eventual job result. Graduate to the
  Bull/Redis-checkpoint `{ jobId }` model when a request creates many tables or for
  eventually-consistent services needing backoff schema refetch (e.g. Notion).
- **Not-yet-supported path (decision #1):** HTTP **200** with
  `status: 'not_supported'` + `unsupported: { service, message }`, so clients branch
  on a typed discriminant rather than an HTTP error.

DTO envelope (as built) — zod schema in
`packages/shared-types/src/dto/schema/create-schema.dto.ts`, validated fully
(structure + intra-request rules) by the global `ZodValidationPipe`:

```ts
// shared-types
export const createSchemaTablesSchema = z
  .object({
    connectorAccountId: z.string().min(1),
    remoteParentId: z.array(z.string()).optional(),
    tables: z.array(createTableSpecSchema).min(1),
    materializeLocally: z.boolean().optional(),
    parentFolderId: z.string().optional(),
  })
  .superRefine((request, ctx) => {
    /* table-ref + table-name uniqueness; every foreignKey {ref} resolves to a table */
  });
export type CreateSchemaTablesDto = z.infer<typeof createSchemaTablesSchema>;
// createSchemaFieldsSchema / generateCreatePlanSchema follow the same shape.

// server bridge — server/src/schema-builder/dto/create-schema.dto.ts
export class CreateSchemaTablesDto extends createZodDto(createSchemaTablesSchema) {}
export class CreateSchemaFieldsDto extends createZodDto(createSchemaFieldsSchema) {}
export class GenerateCreatePlanDto extends createZodDto(generateCreatePlanSchema) {}
```

`/validate` takes a **raw `unknown` body** (not a `ZodDto`), so the pipe passes it
through and the service `safeParse`s it — that's how the dry-run returns the full
issue list instead of throwing a 400.

### 4. Validation (fail-fast at the boundary, before any remote call)

`/validate` **accumulates and returns all** issues; `/tables` and `/fields`
accumulate then throw `BadRequestException` with the full list. Order:

1. `assertWritableWorkbook(actor, workbookId)` — controller **and** service.
2. Connector account exists (`connectorAccountService.findOneById`) **and** belongs
   to this workbook — **add the explicit scoping check** (decision #2), mirroring the
   parent-folder workbook check at `data-folder.service.ts:269`.
3. Structural: non-empty `tables`; each table has ≥1 field; table/field names
   non-empty, trimmed, length-bounded (e.g. 255); **uniqueness is case-insensitive**
   (decision #3) within the request; **at most one field per table sets
   `isPrimary`** (reject multiple with `MULTIPLE_PRIMARY_FIELDS`); `ref` present
   + unique across the request. For `/fields` (and any table whose schema is already
   on disk as a materialized folder), **also validate proposed names case-insensitively
   against the existing field names** read via `getStoredSchema` (decision #3); the
   full check against a *remote* table not materialized locally needs a connector
   fetch and rides along in the connector pass (decision #4).
4. Per-variant union validation (as built) via the **`createFieldTypeSchema`
   `z.discriminatedUnion('kind', …)`**: `select`/`multiSelect` need ≥1 uniquely-named
   option; `currency.currencyCode` matches ISO-4217; `number.precision` in range +
   valid `format`; the `foreignKey` target is a strict two-member union (exactly one
   of `{ref}` / `{existingRemoteTableId}`); an unknown `kind` fails the union. Steps
   3–4 run inside the zod schema, so the `ZodValidationPipe` enforces them on
   `/tables`/`/fields` and `safeParse` surfaces them on `/validate`. Custom
   `superRefine` issues carry stable codes via `params.code` (e.g.
   `DUPLICATE_FIELD_NAME`, `MULTIPLE_PRIMARY_FIELDS`, `FK_UNKNOWN_REF`).
5. Capability + connector-declared requirements: resolve the connector, read
   `supportsSchemaCreation()`; if false the create endpoints return the
   `not_supported` response (validate still returns its issues with
   `schemaCreationSupported: false`). When the connector also implements
   `getSchemaCreationCapabilities()`, the **generic validator consumes it** to **fail
   fast** on connector-specific rules *without hardcoding them in the server or the
   frontend*: every field `kind` must be in `supportedFieldKinds`; if
   `requiresPrimaryField` is true the table must mark exactly one field `isPrimary`
   (of an allowed `primaryFieldKinds`); name lengths must be within the declared limits.
   **Fail-fast is the default policy (decision #9)** — a missing mandatory field is a
   validation error, not silently auto-filled, and **the frontend is expected to call
   `/validate` before `/tables`** so the user fixes the plan first. `autoAdded`
   remains on the result type only for the rare connector that *must* inject a field
   it can't refuse; it is not the primary path.
6. **Concurrency precondition (decision #7 — `// NEEDS FURTHER REVIEW`):** when
   `materializeLocally` is set (or `/fields` targets a materialized folder), refuse if
   that folder is `lock`ed by a `pull`/`publish` op (mirror the lock guard at
   `data-folder.controller.ts`). Add a code comment flagging this precondition for
   further review — the exact set of states that should block, and whether remote
   creation should also be gated, is not yet settled.

**Why zod (as built):** the repo migrated request DTOs to `nestjs-zod`, so the
discriminated union and intra-request rules live natively in the schema —
validated by the global `ZodValidationPipe`, runnable standalone via `safeParse`
(no HTTP), and shared verbatim with the frontends. The connector-capability and
existing-name checks (steps 2, 5) stay in the service because they need runtime
context the schema can't see; they return `ValidateSchemaIssue[]`. The connector
gets the validated `CreateSchemaTablesDto`; the server-only normalizer
(`schema-builder-normalizer.ts`) then topo-sorts and splits cyclic FKs.

### 5. Connector seam (defined, not implemented)

Add to `connector.ts` using both existing patterns:

```ts
supportsSchemaCreation(): boolean { return false; }               // boolean-flag default
/** Declarative, connector-agnostic capabilities + requirements (supported kinds,
 *  mandatory title field, name limits). Optional; the generic validator consumes
 *  it when present so connector rules (Notion/Webflow title) live on the connector,
 *  not the frontend. */
getSchemaCreationCapabilities?(): SchemaCreationCapabilities;
/** Create the table AND its fields (one API call where the service allows). */
createTable?(plan: NormalizedCreateTablePlan): Promise<CreateTableResult>;
/** Add fields to an EXISTING table — also used for the deferred cyclic-FK pass. */
createFields?(plan: NormalizedCreateFieldsPlan): Promise<CreateFieldResult[]>;
```

Capability descriptor (shared interface in `dto/schema/create-schema-responses.dto.ts`):

```ts
export interface SchemaCreationCapabilities {
  supportedFieldKinds: CreateFieldKind[];
  requiresPrimaryField: boolean;          // Notion, Webflow → true
  primaryFieldKinds?: CreateFieldKind[];  // e.g. ['text'] if the title must be text
  maxTableNameLength?: number;
  maxFieldNameLength?: number;
}
```

Normalized plan objects the service hands the connector (as built in
`server/src/remote-service/connectors/schema-creation.types.ts` — placed next to the
connector contract, **not** in `schema-builder/`, so `connector.ts` can reference
them without a connectors→schema-builder import cycle). `createTable` receives **all**
of a table's fields with FK `{ref}` targets resolved to `{ existingRemoteTableId }`
by the server **at dispatch time** (the normalizer fixes ordering + the cyclic-FK
split; the remote-id substitution happens when each sibling is created), so the
connector never sees an unresolved sibling ref:

```ts
/** A field spec whose foreignKey target is guaranteed resolved (server replaced
 *  any in-request {ref} with the created sibling's {existingRemoteTableId}). */
export type ResolvedCreateFieldSpec = CreateFieldSpec;  // narrowed: FK target is always existingRemoteTableId

export interface NormalizedCreateTablePlan {
  remoteParentId?: string[]; ref: string; name: string;
  fields: ResolvedCreateFieldSpec[];          // created WITH the table; the primary field carries isPrimary
  deferredFkFields: ResolvedCreateFieldSpec[]; // cyclic FKs added via createFields after all tables exist
}
export interface NormalizedCreateFieldsPlan {
  remoteTableId: string[]; fields: ResolvedCreateFieldSpec[];
}
/** The whole request, ready to execute: tables in dependency order. */
export interface NormalizedCreateSchemaPlan {
  tablesInCreationOrder: NormalizedCreateTablePlan[];   // topologically sorted by FK deps
}
```

Service flow this pass: validate (incl. connector-declared requirements) →
normalize (topo-sort tables, resolve `{ref}` → remote-id form, split out cyclic
FKs) → if `!connector.supportsSchemaCreation()` return `not_supported`; otherwise
dispatch `createTable` per table in order, then `createFields` for any deferred
cyclic FKs (unreachable in prod, exercised by a test stub). Connectors only ever
receive a fully-validated, FK-resolved plan — all validation/ordering/materialize
stays server-side; table+field creation strategy stays connector-side.

### 6. Module placement & files

New module **`server/src/schema-builder/`** (avoids clashing with publish-plan's
`schema-helper.service.ts`), imports `WorkbookModule` (→ `WorkbookService` +
`DataFolderService`), `ConnectorsModule`, `ConnectorAccountModule`, `DbModule`,
`AuditLogModule`, `RateLimiterModule`; registered in `app.module.ts`.

Created (as built):
- `schema-builder.module.ts`
- `schema-builder.controller.ts` — 4 routes (`plan-from-folder`, `validate`,
  `tables`, `fields`); `ScratchAuthGuard`, `ApiRateLimitGuard`; `userToActor`;
  controller-level `assertWritableWorkbook`.
- `schema-builder.service.ts` — validate + normalize + dispatch + materialize +
  audit-log. (`executeCreateTables` is the BullMQ-wrappable core.)
- `schema-builder-validator.ts` — pure `zodErrorToValidateIssues`,
  `validateTablesAgainstCapabilities`, `validateFieldsAgainstCapabilities`,
  `validateNamesAgainstExisting`, `formatIssuePath`.
- `schema-builder-normalizer.ts` — pure `normalizeCreateSchema` (topo-sort +
  cyclic/self-FK deferral).
- `schema-builder-plan-generator.ts` — pure `inferLogicalFieldType(...)` +
  `generateCreatePlanFromSources(...)`; reuses `extractSchemaFields`
  (`server/src/utils/schema-helpers.ts`).
- `dto/create-schema.dto.ts` — the `createZodDto` bridge classes.
- `__tests__/`: `schema-builder-validator.spec.ts`, `schema-builder-normalizer.spec.ts`,
  `schema-builder-plan-generator.spec.ts`, `schema-builder.controller.e2e.spec.ts`
  (29 tests).

Edited / added elsewhere:
- `packages/shared-types/src/dto/schema/create-schema.dto.ts` +
  `create-schema-responses.dto.ts` (new) + barrel exports in `src/index.ts`.
- `server/src/remote-service/connectors/schema-creation.types.ts`
  (server-only normalized-plan contract).
- `server/src/remote-service/connectors/connector.ts` — added the seam.
- `server/src/app.module.ts` — registered `SchemaBuilderModule`.
- **`packages/shared-types/src/api-client/resources/schema.ts`** (new) +
  registered as `client.schema.*` in `api-client/client.ts` — the shared REST
  client surface both frontends consume (the post-refactor methodology).

**Out of scope (on record):** app-specific SWR hooks / UI in `/client` and
`/scratch-desktop` (the endpoints are imperative mutations, not SWR data loads), and
the Rust CLI (`scratch-git-2/src/cli/`).

### 7. Principle alignment

- **Composable independent systems**: own module; reuses `createFolder`,
  `getStoredSchema`/`extractSchemaFields`, and the connector abstraction rather than
  reimplementing them. Each endpoint is independently runnable and its output feeds
  the next: `plan-from-folder` (read) → review/edit → `validate` (dry-run) →
  `tables`/`fields` (execute). `plan-from-folder` and `validate` ship fully working
  this pass with no connector creating anything.
- **Discover dynamically / connector knowledge off the frontend**: only logical
  types cross the wire; native mapping lives in future connectors; materialize
  re-`fetchJsonTableSpec`s the *actual* created schema rather than echoing input.
- **Surface failures**: per-table/per-field `status` + `error`, request-level
  `partial`, explicit `not_supported` — never a fake success.
- **Non-destructive**: creates are purely additive; no drop/rename endpoints.
- **Honest about idempotency**: creates are **not** idempotent (re-POST ⇒ a second
  table); no dedupe this pass. Partial-failure results let callers retry only the
  failed pieces; true resumability belongs to the future job model. Documented, not
  overclaimed.

---

## Verification (this pass — no connector executes creates)

Repo conventions: co-located `__tests__/*.spec.ts`; e2e boots a NestJS
`TestingModule` + supertest with `ScratchAuthGuard`/`ApiRateLimitGuard` overridden
and services mocked (see `server/src/cli/__tests__/upload-patch.controller.e2e.spec.ts`).
Run with `yarn test` and `yarn test:integration` from repo root; finish with
`yarn build` + `yarn lint`.

1. **Pure validator unit tests** — every `CreateFieldType` variant (valid + each
   failure code), ref uniqueness, FK resolution (existing / `{ref}` / ambiguous /
   unknown), the single-`isPrimary` rule (reject multiple per table),
   case-insensitive name uniqueness + length, the case-insensitive existing-name
   check (via a stubbed `getStoredSchema`), and capability-driven fail-fast
   (unsupported kind, missing required primary field).
2. **Controller e2e** — `/validate` returns full `issues[]` for a broken payload and
   `valid:true` for a good one (proves the contract end-to-end with no connector);
   `/tables` + `/fields` against a real connector return `status:'not_supported'`.
3. **Stub connector** registered in the test module with `supportsSchemaCreation()`
   true and canned `createTable`/`createFields` returning synthetic remote ids —
   exercises dispatch and, with `materializeLocally:true`, asserts
   `DataFolderService.createFolder` is called with `tableId:[newRemoteId]` and that
   `dataFolderId` flows into the response.
4. **Audit** assertion — the stub-dispatch e2e asserts `auditLogService.logEvent`
   fires on create (PostHog tracking is deferred; see As-built notes).
5. **`plan-from-folder`** is fully testable now (read-only): unit-test
   `inferLogicalFieldType` over representative source schemas (checkbox, number,
   date, url, richtext, enum-union, FK-annotated, read-only/computed → text); e2e that
   seeds a workbook + **two** source folders whose schemas reference each other via
   `X_SCRATCH_FOREIGN_KEY_OPTIONS` and asserts the generated multi-table `plan`
   (one `CreateTableSpec` per source, the `titleColumnRemoteId` field marked
   `isPrimary`, the cross-folder FK resolved to `{ ref }`), an FK with no matching source/mapping
   flagged `unsupported`, and the `notes[]` (mapped / downgraded / unsupported). Stub
   the destination connector's `getSchemaCreationCapabilities()` to exercise
   unsupported-kind flagging.

---

## Decisions (resolved with stakeholder)

All baked into the sections above; logged here for traceability.

1. **Not-supported transport** → HTTP 200 + `status:'not_supported'` (not 501).
2. **Account↔workbook scoping** → add the explicit check that the connector account
   belongs to the workbook.
3. **Names** → case-insensitive uniqueness; also validate proposed names
   case-insensitively against existing field names (via `getStoredSchema` when the
   schema is on disk; remote-only tables ride along in the connector pass).
4. **`existingRemoteTableId` existence** → structural-only now; real remote check
   deferred to the connector pass (accepted).
5. **v1 type coverage** → the 12-variant union is the agreed starting set. (Future
   additions are non-breaking; the `assertUnreachable` switch flags every connector
   that must handle a new member.)
6. **`materializeLocally` partial failure** → report `created` + `materializeError`
   (the remote table genuinely exists; no rollback implied).
7. **Concurrency precondition** → block when the folder is locked (`pull`/`publish`),
   **and carry a `// NEEDS FURTHER REVIEW` comment** — the exact blocking states are
   not settled.
8. **Async** → synchronous now, but the core is coded as a standalone unit a future
   BullMQ job can wrap unchanged.
9. **Mandatory-field policy** → **fail-fast** (validator rejects); the frontend runs
   `/validate` before `/tables`. Auto-inject is not the default.
10. **Primary-field designation** → an `isPrimary?: boolean` flag on
    `CreateFieldSpec` (not a `primaryFieldName` reference on the table). Validation
    rejects a table that marks more than one field `isPrimary`
    (`MULTIPLE_PRIMARY_FIELDS`).
11. **`plan-from-folder` FK handling** → support FKs only when the linked table is
    another source in the same (multi-table) request → `{ref}`, or already exists on
    the destination via `linkedTableMappings` → `{existingRemoteTableId}`; otherwise
    flag `unsupported`. **Multi-table plans are expected to be a common use case.**
12. **Downgrade aggressiveness** → map `currency`/`email`/`phone` when source
    annotations are unambiguous; otherwise non-FK unmappable fields downgrade to
    `text` (FKs are flagged `unsupported`, never downgraded).

---

## As-built notes

What landed in this pass, where it diverged from the plan above, and what is
deliberately deferred. Verified green: shared-types build + lint, server typecheck +
lint, 29 schema-builder tests.

**Deviations from the original plan**

- **zod, not a hand-written normalizer.** The repo migrated request DTOs to
  `nestjs-zod` after this doc was first written. The logical field-type union is a
  `z.discriminatedUnion`; intra-request rules are `superRefine`s with stable
  `params.code`s. The class-validator envelope and `normalizeCreateFieldType` switch
  in the original Sections 3–4 were not built.
- **Normalized-plan types** live in `connectors/schema-creation.types.ts` (next to
  the connector contract) to avoid an import cycle — not in `schema-builder.types.ts`.
- **`{ref}` → remote-id resolution happens at dispatch**, not during normalization
  (the remote ids don't exist until tables are created). The normalizer only fixes
  creation order and the cyclic-FK split.
- **Shared api-client resource added** (`resources/schema.ts`, `client.schema.*`) —
  per the master refactor that consolidated both frontends' REST layers. This was
  originally listed as out-of-scope "web client API"; the shared resource is now in.

**Deferred (not implemented this pass)**

- **No connector implements `supportsSchemaCreation()`** — by design (#4). In
  production `/tables` and `/fields` return `not_supported`; the dispatch +
  materialize path is exercised only by a test stub.
- **Concurrency precondition (#7)** — the `materializeLocally` / `/fields` lock gate
  was **not** implemented; it was flagged "NEEDS FURTHER REVIEW" and the exact
  gating is unsettled.
- **`refreshLocalSchema`** — accepted in the contract but a logged TODO; meaningful
  only once a real connector executes field creation.
- **PostHog tracking** — audit logging is wired; PostHog is deferred (it only fires
  on real creation, which can't happen until a connector lands).
- **Remote existing-field-name check** for tables not materialized locally (#3/#4) —
  deferred to the connector pass (needs a connector fetch).
- **`TableView` (`TablePropertyType`) hints in plan generation** —
  `inferLogicalFieldType` accepts a hint, but the service doesn't yet supply one (no
  stored-view getter exists), so inference currently uses the JSON-Schema type +
  generic `x-scratch-*` annotations only.
- **Frontend UI / SWR hooks** and the **Rust CLI** — out of scope.
