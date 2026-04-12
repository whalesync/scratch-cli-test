# Unify connector picker grouping and workbook folder hierarchy

**Status:** proposed
**Author:** investigation-driven, see "Background" below

## Context

Connectors describe their tables in two places:

1. **`TablePreview`** (returned from `Connector.listTables()`) — populates the table picker UI when a user is choosing which tables to add to a workbook.
2. **`BaseJsonTableSpec`** (returned from `Connector.fetchJsonTableSpec()`) — describes the table's schema and is the source of truth used to compute the on-disk file layout when a `DataFolder` is created.

Both objects have a field that controls "where this table sits in a hierarchy":

- `TablePreview.parentPath: string | undefined` — controls grouping in the picker.
- `BaseJsonTableSpec.basePath: string[]` — controls the folder hierarchy in the actual workbook tree (consumed in `data-folder.service.ts:702-704` `buildConnectorFolderPath`).

These are separate fields on separate objects returned by separate methods, with **no enforcement that they agree**. The connector author has to remember to set both, in two places, with values that match.

## Problem

The split has caused real bugs in already-merged code, not just hypothetical concerns. As of 2026-04-11, three live examples in `server/src/remote-service/connectors/library/`:

| Connector                           | `parentPath` (picker)                                                | `basePath` (workbook tree)                          | Symptom                                                                                                                                                                                       |
| ----------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Affinity** (fixed in this branch) | `'Lists'` for user lists                                             | was `[]`, now `['Lists']`                           | Picker showed user lists nested under "Lists/", but the workbook sidebar rendered all lists flat alongside the three tenant tables. Discovered when QA-testing the new tenant-tables feature. |
| **HubSpot**                         | `'Custom Objects'` for custom objects (`hubspot-connector.ts:101`)   | `[]` (`hubspot-json-schema.ts:130`)                 | Custom objects appear under "Custom Objects/" in the picker but flat in the workbook tree alongside standard CRM objects. Unfixed in main.                                                    |
| **Supabase**                        | `'${groupName}/${schema}'` (two levels, `supabase-connector.ts:406`) | `[schema]` (one level, `supabase-connector.ts:511`) | Picker tells the user files will land under `MyProject/public/users`, but they actually land under `public/users` — the project name layer silently disappears. Unfixed in main.              |

The Affinity bug is the most concerning because it was found during the _first_ attempt to use a non-trivial picker grouping in a new connector. The footgun is right at the entry point.

The connectors that _don't_ have this problem fall into two camps:

- **Both fields set consistently** (Webflow, Airtable, current Affinity) — the connector author got it right by hand. No language or compiler help.
- **Both fields empty** (Stripe, Brevo, Notion, Intercom, etc.) — flat connectors that never trigger the bug because they have no hierarchy to lose track of.

So the bug rate among connectors that _try_ to use a picker hierarchy is currently **3/5 (60%)**.

## Why are they separate today?

The architectural justification: `listTables()` is called every time the picker opens and has to be cheap, while `fetchJsonTableSpec()` is only called once a specific table is selected and can be expensive (it fetches per-table schema metadata). Splitting "where does this go in the picker" from "where does this go in the workbook" lets the picker render without paying the per-table schema cost.

That's a real concern, but it's narrower than the API surface implies. **In every existing connector**, `basePath` is derived from data the connector already has in hand at `listTables` time:

| Connector | `basePath` value                     | Source                                                       |
| --------- | ------------------------------------ | ------------------------------------------------------------ |
| Webflow   | `[site.displayName]`                 | Already known from the site list                             |
| Airtable  | `[base.name]`                        | Already known from the base list                             |
| Postgres  | `[id.remoteId[0]]`                   | Comes directly from the EntityId — already in `TablePreview` |
| Supabase  | `[schema]`                           | Already known from the schema list                           |
| Affinity  | `['Lists']`                          | Hardcoded constant                                           |
| HubSpot   | `[]` (intended `['Custom Objects']`) | Hardcoded constant                                           |

There is no real-world connector today where `basePath` requires data that only `fetchJsonTableSpec` can produce. The "we can't know the hierarchy without the schema" rationale doesn't apply to anything that ships.

## Proposed change

**Make the picker and the workbook tree share a single source of truth: a path array on `TablePreview` that's used by both consumers.**

The picker will render its grouping from this field. When a `DataFolder` gets created from a picker selection, the same field is used (passed through to `data-folder.service.ts`) to compute the workbook path. `BaseJsonTableSpec.basePath` goes away as a connector-supplied field.

### New shape

```typescript
// connectors/types.ts
export type TablePreview = {
  id: EntityId;
  displayName: string;
  /**
   * Folder hierarchy this table belongs in. Used for BOTH the picker grouping
   * AND the actual workbook tree path. Empty array means top-level.
   *
   * Examples:
   *   []                       → top-level table
   *   ['Lists']                → one-level folder ("Lists/<table>")
   *   ['MyProject', 'public']  → two-level folder ("MyProject/public/<table>")
   */
  parentPath?: string[];

  // ... existing fields (disabled, disabledReason, metadata, etc.)
};

// connectors/types.ts (or wherever BaseJsonTableSpec lives)
export type BaseJsonTableSpec = {
  // ... existing fields
  // basePath: REMOVED — folder hierarchy now lives on TablePreview
};
```

`parentPath` becomes a `string[]` instead of a `string`. The current `string` form (e.g. `'Custom Objects'` or `'MyProject/public'`) is ambiguous about whether `/` is a separator or a literal character — a list makes that explicit. Supabase's compound path becomes `['MyProject', 'public']` rather than `'MyProject/public'`, which is unambiguous and matches how `basePath` already works.

### How DataFolder creation finds the path

`data-folder.service.ts` already has the `tableId` (which is `EntityId.remoteId`) and the `connectorAccountId` at folder-creation time. To find the hierarchy:

**Option A — pass `parentPath` through the create-folder DTO.** When the picker submits a folder-create request, it includes the `parentPath` from the `TablePreview` it just rendered. This is the cheapest change and the picker already has the data in hand.

**Option B — re-call `listTables()` server-side** to find the matching `TablePreview` and read its `parentPath`. Avoids any DTO changes but adds an extra connector roundtrip on every folder create. Probably not worth it.

**Option C — store `parentPath` on `DataFolder` itself, alongside `tableId`.** Self-contained, no DTO change, but adds a new column.

Recommendation: **Option A**. The DTO already carries arbitrary picker context (filter, idFieldOverride, etc.) and adding one more field is trivial. The data is already on the client at create time.

### `buildConnectorFolderPath` after the change

```typescript
buildConnectorFolderPath(
  _connectorDisplayName: string,
  tableSpec: BaseJsonTableSpec,
  parentPath: string[] | undefined,            // NEW: from the create DTO
  parentFolderPath?: string,
): string {
  // ... existing escape logic ...
  const parts: string[] = [];

  if (parentFolderPath) {
    parts.push(parentFolderPath.replace(/^\//, ''));
  }

  if (parentPath && parentPath.length > 0) {
    parts.push(...parentPath.filter(Boolean).map(escape));
  }

  parts.push(escape(tableSpec.name));

  return '/' + parts.join('/');
}
```

The function gets `parentPath` from the new DTO field instead of reading it off `tableSpec`. `tableSpec.basePath` is no longer referenced anywhere.

## Migration plan

### Files that change

**Type definitions (1 file):**

- `server/src/remote-service/connectors/types.ts` — `parentPath: string` → `parentPath?: string[]`. Remove `basePath` from `BaseJsonTableSpec`.
- `packages/shared-types/src/connector-types.ts` — same, if the type lives there too.

**Picker frontend (client/):**

- The picker rendering code that consumes `parentPath` needs to handle the array shape — joining with `/` for display, splitting on the array boundaries for tree nesting. Probably a single helper function. Worth a focused look during implementation; not investigated yet.

**Folder creation pipeline:**

- `server/src/workbook/dto/create-data-folder.dto.ts` — add `parentPath?: string[]` field.
- `server/src/workbook/data-folder.service.ts` — `createFolder` accepts the DTO field and passes it to `buildConnectorFolderPath`. `buildConnectorFolderPath` no longer reads `tableSpec.basePath`.

**Connectors that currently set `parentPath` (5 files):**

| File                           | Current                                  | New                               |
| ------------------------------ | ---------------------------------------- | --------------------------------- |
| `affinity-connector.ts:174`    | `parentPath: 'Lists'`                    | `parentPath: ['Lists']`           |
| `webflow-connector.ts:110`     | `parentPath: site.displayName`           | `parentPath: [site.displayName]`  |
| `webflow-schema-parser.ts:16`  | same                                     | same                              |
| `airtable-schema-parser.ts:13` | `parentPath: base.name`                  | `parentPath: [base.name]`         |
| `supabase-connector.ts:406`    | `parentPath: \`${groupName}/${schema}\`` | `parentPath: [groupName, schema]` |
| `hubspot-connector.ts:101`     | `parentPath: 'Custom Objects'`           | `parentPath: ['Custom Objects']`  |

**Connectors that currently set non-empty `basePath` in their JSON schema (5 files):**

These all just delete the `basePath` line. The hierarchy is now expressed once, on `TablePreview`. Note that **HubSpot and Supabase get bug fixes for free** because the inconsistent `basePath` value goes away and they pick up the correct hierarchy from their already-correct `parentPath`.

| File                             | Current `basePath`                               | After     |
| -------------------------------- | ------------------------------------------------ | --------- |
| `affinity-json-schema.ts:197`    | `['Lists']`                                      | _removed_ |
| `webflow-json-schema.ts:250,310` | `[site.displayName ?? site.shortName ?? '']`     | _removed_ |
| `airtable-json-schema.ts:70`     | `[base.name]`                                    | _removed_ |
| `postgres-connector.ts:226`      | `id.remoteId[0] ? [id.remoteId[0]] : ['public']` | _removed_ |
| `supabase-connector.ts:511`      | `[schema]`                                       | _removed_ |

**Connectors that currently set empty `basePath: []` (~14 files):**

Same — just delete the `basePath: []` line. Removes a meaningless field from every connector and one less thing to remember.

**Tests:**

- `server/src/remote-service/connectors/library/affinity/__tests__/affinity-connector.spec.ts` — updates to assert `parentPath` array on `TablePreview` instead of `basePath` on the spec. Tests added in this branch already cover the right invariant, just on the wrong field.
- `server/src/remote-service/connectors/library/stripe/__tests__/stripe-json-schema.spec.ts:27` — `expect(spec.basePath).toEqual([])` — delete this assertion.
- Any other existing tests that touch `basePath` (worth a `grep` pass during implementation).

### Rollout sequence

1. **Add the new field to `TablePreview` as a parallel** (`parentPathV2: string[]`?) and have `data-folder.service.ts` prefer it when set, falling back to the old `basePath`. This lets connectors migrate one at a time without breaking anything.
2. **Migrate every connector** to set the new field. Verify each one in QA against the picker + workbook tree. Five connectors with hierarchies + ~14 with flat layouts that just need the empty-array form.
3. **Once all connectors are migrated**, delete `BaseJsonTableSpec.basePath` and rename `parentPathV2` to its final name. This is a breaking type change but at this point no consumer reads the old fields.
4. **Drop the old `parentPath: string` form on `TablePreview`** in the same step, since both the picker frontend and the server now use the array form.

A more aggressive single-PR approach is also possible, since the consumer count is small (one consumer in `data-folder.service.ts`, one in the picker frontend) — but the parallel-field rollout is safer because every existing user-created `DataFolder` keeps working unchanged throughout the migration.

## Risks & open questions

1. **Existing `DataFolder` rows have paths baked in.** A `DataFolder` created today as `/All People` won't auto-migrate to `/Lists/All People` after the change — the path column is just a string. This isn't a _new_ problem (it already exists today: any change to a connector's `basePath` strands existing folders at their old path), but it's worth being explicit that this refactor doesn't introduce a migration story for in-flight workbooks. The expectation is that users delete and re-add affected folders if they want the new hierarchy. Worth mentioning in release notes when the affected connectors ship.

2. **HubSpot custom objects and Supabase tables will move.** These are the two cases where the existing inconsistency means the workbook tree currently looks "wrong" relative to the picker. Fixing that is the _point_ of the refactor, but it means existing HubSpot/Supabase users will see their tree change shape. Affected connectors should ship behind a release-notes flag explaining the change. Or — if the user disagreement on the rename direction is significant — keep the current (broken) behavior for HubSpot and Supabase by setting the new `parentPath` to match the old `basePath` rather than the old `parentPath`. That's the lower-risk migration if anyone has built workflows that depend on the current (incorrect) tree shape.

3. **Picker frontend impact is unscoped.** This plan covers the server side. The picker rendering code in `client/` will need to handle the new `string[]` shape — almost certainly a small change but I haven't read it yet. Worth a 30-minute look at the picker tree component before committing to the rollout sequence above.

4. **Should `parentPath` move into a different name entirely?** The current name is misleading because it sounds like "the path of my parent" rather than "the folder hierarchy this table goes in." Possible alternatives: `folderPath`, `hierarchyPath`, `groupPath`, `treePath`. This is a bikeshed but worth deciding before the rename in step 4 of the rollout.

5. **Does the picker need a separate "grouping for display only" concept?** The whole premise of this plan is "picker hierarchy and workbook hierarchy are always the same thing in practice." That's empirically true today (5/5 connectors that try). But if a future connector wants e.g. a "Favorites" or "Recently used" picker category that _doesn't_ become a real folder, this design takes that off the table. Mitigation: that's a UI concern, not a connector concern, and the picker frontend can implement it without involving the connector contract. But worth flagging as the one design freedom this refactor gives up.

## Background

This plan was triggered by a real bug. While building the new tenant-wide tables feature for the Affinity connector (`Companies/`, `People/`, `Opportunities/` at the workbook root + `Lists/` for user-created lists), the picker correctly showed user lists nested under `Lists/` because `parentPath: 'Lists'` was set on `TablePreview`. But after creating a `DataFolder` for one of those lists, the workbook sidebar showed it flat at the root alongside the tenant tables.

The fix (`affinity-json-schema.ts:197`) was to set `basePath: ['Lists']` on the table spec. One-line change, but the bug class is structural: there's no compile-time link between picker grouping and workbook hierarchy, and the connector author has to remember to set them in two different places. Searching for the same bug in other connectors immediately turned up two more: HubSpot custom objects and Supabase tables, both with mismatched `parentPath` and `basePath` in main.

This document proposes eliminating the duplication so the third bug is the last one of its kind.
