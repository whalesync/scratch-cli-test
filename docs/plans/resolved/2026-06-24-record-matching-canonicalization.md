# Plan: Direction-independent record matching via per-field canonicalization

**Date:** 2026-06-24
**Status:** Resolved
**Author:** Ryder Ziola
**Area:** `server/src/sync` (record matching), `packages/shared-types`, `client` sync editor

## Problem

Syncing identifies which source record corresponds to which destination record using a
**record matching field** (a.k.a. match key): a `{ sourceColumnId, destinationColumnId }`
pair on each table mapping. Two records match when their match-field values are equal.

Some connectors store a field's value as a non-primitive envelope rather than a bare
scalar. The canonical example is a Notion `rich_text` field:

```json
{
  "type": "rich_text",
  "rich_text": [{ "text": { "content": "09b70260-5438-4587-a536-0b2cd41be203" }, "type": "text" }]
}
```

The match comparison can only compare **primitives** (string/number). Today the source
side is run through the **column-mapping copy transformers** before comparison, and the
destination side is compared **raw**. That makes matching work in exactly one direction:

- **Notion → Postgres (works):** the copy transformer for the match column is
  `[notion-unpack (rich_text → plain text)]`, so the source value reduces to the inner
  string and compares against the raw Postgres string. ✅
- **Postgres → Notion (fails):** the copy transformer is `[notion-pack (plain text →
  rich_text envelope)]`, so the source string is turned **into** a Notion object. An
  object can't be a match key, so no source key is produced; meanwhile the destination
  (Notion) value is compared raw and is also an object. Both sides fail. ❌

The UI surfaces this as:

> Source record has an invalid value (of type object) for the record matching field "id".
> This record will not be matched during sync.

### Root cause

Match comparison is piggy-backing on the **copy** transformers, which are intentionally
**direction-specific** (they reshape a value from the source's shape into the
destination's shape). Matching needs the opposite: a **direction-independent canonical
primitive** for each side, computed from each field independently.

## Chosen approach (the user's Option 2)

At comparison time, **ignore the column-mapping copy transformers entirely** and reduce
each side's match-field value to a canonical primitive with a per-field rule:

1. **Primitive value** (string/number): use it directly (`String(v).trim()`).
2. **Has a built-in suggested extraction-side transformer**: apply that transformer to
   extract the primitive, then `String().trim()` the result.
3. **Neither applies**: the field is **not usable** as a match key (warn + skip; surface
   in the editor as a disabled option).

This is symmetric: both sides reduce through their **own** field's extraction transformer,
so Postgres↔Notion now matches in both directions (`"09b70260…"` on both sides).

### Why this is the right fit (validated against the code)

The "built-in suggested extraction-side transformer" already exists and is exactly what we
need — it is **not** the copy transformer:

- `X_SCRATCH_SUGGESTED_TRANSFORMER` (`x-scratch-suggested-transformer`) is documented in
  `packages/shared-types/src/transform-picker.ts` as the **unpack** hint that
  "unpacks the field's native value INTO that plain value, and applies when the field is
  the sync SOURCE (e.g. a Notion `rich_text` array → a plain string)." That is precisely
  the extraction-side transformer the plan wants — and it is intrinsic to the field, not to
  a copy direction.
- It is declared per field-type by each connector in its JSON schema builder (e.g. Notion
  `notion-json-schema.ts`, including the `title` virtual-field variant), so this is
  connector-knowledge that already lives on the server and is surfaced generically — no
  frontend learns anything connector-specific (honors the "keep connector knowledge out of
  the frontends" principle).
- It is already extracted from a stored schema into `SchemaField.suggestedTransformer` by
  `extractSchemaFields()` (`server/src/utils/schema-helpers.ts:101`), which also correctly
  handles **virtual fields** (e.g. Notion `title`) and nullable unions. We can reuse it
  verbatim to fetch the per-field unpack transformer at match time.

`LAZY 1` (hashing the object) is correctly rejected: it is fragile (requires byte-identical
structure across services, which never holds — Notion includes `annotations`, `href`,
per-span `plain_text`, etc.), unreadable, and provides no path to a useful editor warning.

## How matching works today (the three code paths that must agree)

Match keys flow through the `SyncMatchKeys` table (`matchId` column). There are **three**
places that derive/compare a match key, and a correct fix must keep all three consistent:

1. **Source key derivation** — `insertSourceMatchKeys()` / `insertTransformedMatchKeys()`
   (`sync.service.ts:2008`, `:2060`). Applies the match column's **DATA-phase copy
   transformers** then type-checks (`:2119`). This is the direction-specific step that
   breaks Postgres→Notion.
2. **Destination key derivation** — `insertDestinationMatchKeys()` → `insertMatchKeys()`
   (`sync.service.ts:2155`, `:1972`). Reads the value **raw**, type-checks (`:1981`),
   stores `String(v)`.
3. **Comparison**:
   - **Pass 2 (the actual join):** `buildRecordMatchingMappings()` self-joins
     `SyncMatchKeys` on `src.matchId = dest.matchId` (`sync.service.ts:1688`). This is the
     true source↔destination correspondence — it just compares stored `matchId` strings,
     so fixing (1) and (2) automatically fixes the join.
   - **Pass 3 (classify unmatched destinations):** `classifyDestinationRecord()`
     (`sync-execution.ts:322`) **re-derives the destination key from raw** and checks
     membership in the source `matchId` set (`sync.service.ts:1465-1482`).

So the canonical "reduce to a comparable primitive" rule must be applied identically in
(1), (2), and (3).

## Implementation plan

### 1. One canonicalization rule, two implementations (server runtime + shared static)

The runtime reducer must execute a transformer, which only the server can do
(`applyTransformerPipeline` lives in `server/src/sync/transformers`). The editor only needs
a static yes/no. Both follow the **same rule**, so define the rule once conceptually and
implement:

**a) Server runtime reducer** — new `server/src/sync/record-matching.ts`:

```ts
/**
 * Reduce a raw match-field value to its canonical match key, independent of sync
 * direction. Returns null when the field is not usable as a match key.
 */
export async function deriveCanonicalMatchKey(
  rawValue: unknown,
  suggestedUnpackTransformer: TransformerConfig | undefined,
  ctx: MatchKeyTransformContext, // existing context: table specs, services, noop lookup tools
): Promise<string | null> {
  // 1. Primitive → use directly.
  if (isNonEmptyPrimitive(rawValue)) return String(rawValue).trim();
  // 2. Non-primitive with an extraction transformer → unpack, then require a primitive.
  if (rawValue != null && suggestedUnpackTransformer) {
    const result = await applyTransformerPipeline([suggestedUnpackTransformer], rawValue, { ...ctx, phase: 'DATA' });
    if (result.success && isNonEmptyPrimitive(result.value)) return String(result.value).trim();
  }
  // 3. Otherwise unmatchable.
  return null;
}
```

**b) Shared static predicate** — new `packages/shared-types/src/match-field.ts`:

```ts
import { FieldTransformHints } from './transform-picker';

export type MatchFieldCompatibility =
  | { usable: true }
  | { usable: false; reason: 'object-without-extractor' /* | future reasons */ };

const PRIMITIVE_MATCH_TYPES = new Set(['string', 'number', 'integer']);

/** Mirror of deriveCanonicalMatchKey's rule, decided from schema hints alone. */
export function getMatchFieldCompatibility(field: FieldTransformHints | undefined): MatchFieldCompatibility {
  if (field && PRIMITIVE_MATCH_TYPES.has(field.type ?? '')) return { usable: true };
  if (field?.suggestedTransformer) return { usable: true }; // extraction transformer present
  return { usable: false, reason: 'object-without-extractor' };
}
```

Re-export from the shared-types barrel. The server imports `getMatchFieldCompatibility`
too so the editor and the executor share one source of truth for "is this field a legal
match key."

> Note: the static predicate is a *necessary* check, not a *sufficient* one — a field can
> declare a `suggestedTransformer` whose runtime output is still non-primitive, which (a)
> catches at sync time. That is acceptable: the editor disables the clearly-incompatible
> fields up front; the executor remains the authority and still warns/skips on the rare
> runtime miss.

### 2. Fetch the per-field unpack transformer at match time

Add a small helper (next to `record-matching.ts`) that resolves a column id to its unpack
transformer from a loaded `BaseJsonTableSpec`, **reusing `extractSchemaFields`** so virtual
fields (Notion `title`) and nullable unions are handled identically to the editor:

```ts
export function getFieldUnpackTransformer(spec: BaseJsonTableSpec | null, columnId: string): TransformerConfig | undefined {
  if (!spec?.schema) return undefined;
  return extractSchemaFields(spec.schema).find((f) => f.path === columnId)?.suggestedTransformer;
}
```

Both `sourceTableSpec` and `destinationTableSpec` are already loaded and in scope where
match keys are built. Compute the unpack transformer **once per side per batch** (it is
per-field, not per-record).

### 3. Rewire the three code paths

- **Unify match-key insertion.** Generalize `insertMatchKeys(...)` to accept an optional
  `suggestedUnpackTransformer` + `ctx` and route every value through
  `deriveCanonicalMatchKey`. Collapse `insertSourceMatchKeys`,
  `insertTransformedMatchKeys`, and `insertDestinationMatchKeys` into this single path:
  - **Source:** look up source field's unpack via `getFieldUnpackTransformer(sourceTableSpec, recordMatching.sourceColumnId)`. **Stop** consulting the column-mapping copy transformers and the `getColumnMappingPhase` branch (delete `insertTransformedMatchKeys`).
  - **Destination:** look up destination field's unpack via `getFieldUnpackTransformer(destinationTableSpec, recordMatching.destinationColumnId)` instead of reading raw-only.

- **Pass 3 classification.** Change `classifyDestinationRecord` to stop re-deriving the key
  from raw. Drive it off the **already-canonicalized destination `SyncMatchKeys` rows**:
  build `Map<destinationRemoteId, matchId>` from the destination rows (we already insert
  them in step (2)); then:
  - no entry for the record → `unmatchedWithoutMatchKey`,
  - entry present and `matchId ∈ sourceMatchKeySet` → `matched`,
  - entry present and not in the set → `unmatchedWithMatchKey`.
  This keeps Pass 3 perfectly consistent with the Pass 2 join (single source of truth) and
  removes the only remaining raw `typeof` check. Update the function's doc comment, which
  currently documents the raw-only rule.

- **Preview / editor validation.** `previewRecord` (`sync.service.ts:2300-2312`) currently
  validates **only the source** using the **copy-transformed** value. Update it to mirror
  the new rule for **both** sides via `deriveCanonicalMatchKey` + `getFieldUnpackTransformer`,
  and rewrite `validateMatchFieldValue`'s message to describe *incompatibility*
  ("This field can't be used for record matching because its value is a … with no way to
  extract a plain value") rather than the misleading "invalid value (of type object)".

### 4. Client: disable incompatible match-field options

`client/.../MainPane/SyncEditor.tsx` (match picker at `:1535-1577`) already holds a
`schemaCache` keyed by folder with `{ path, type, suggestedTransformer, suggestedInTransformer }`
per field — exactly the `FieldTransformHints` the shared predicate consumes.

- For each candidate `source <-> dest` pair, compute
  `getMatchFieldCompatibility(sourceHints)` and `…(destHints)`. If either is `usable:false`,
  render the `Select` option as **disabled** with a reason (Mantine `Select` supports
  per-option `disabled`; show the reason via option tooltip / description).
- Keep the existing server `recordMatchingWarning` alert as the runtime backstop, but its
  copy should match the new wording.
- **scratch-desktop:** there is currently **no** sync editor in `scratch-desktop/src`
  (confirmed by search), so no desktop change is needed today; putting the predicate in
  shared-types future-proofs it for when desktop gains a sync editor.
- **CLI:** `scratch-git-2/src/cli/commands/syncs.rs` deals with syncs but is Rust and does
  not edit match fields interactively; out of scope. Note it in the doc so a future CLI
  match-field editor reimplements the same rule.

### 5. Behavior-change / backward-compatibility note

The change **stops honoring custom column-mapping transformers on the match column at match
time.** This is safe for the common cases:

- number↔string mismatches still match, because `deriveCanonicalMatchKey` `String()`-coerces
  both sides (so a prior `auto_convert`/`string_to_number` on the match column is moot at
  comparison time).
- the previously-broken object-valued cases (Postgres→Notion) now match — the intended win.

The only regression risk is a sync whose match column carries a **hand-configured, non-default
transformer** that produced a primitive the raw other side happened to equal, where the
field's *suggested* extraction (or raw, if primitive) yields a different canonical value.
These are rare and enumerated by the audit query (below) for manual review before rollout.

## Documentation plan

1. **`server/src/sync/README.md`** — add a "Record matching" section:
   - the `{ sourceColumnId, destinationColumnId }` model and the `SyncMatchKeys`-driven
     join (Pass 2) + Pass 3 classification;
   - the **canonicalization rule** (primitive | suggested extraction transformer |
     unmatchable) and that it is **direction-independent** and deliberately does **not**
     use the copy transformers;
   - a worked Notion↔Postgres example in both directions.
2. **`docs/sync-flow.md`** — cross-link the new matching section.
3. **Inline:** rewrite the `classifyDestinationRecord` doc comment and
   `validateMatchFieldValue` message to match the new rule.
4. **External:** the editor links to `https://docs.scratch.md/sync/record-matching`
   (`client/src/utils/docs-urls.ts:4`) — flag to the docs owner to update that page with
   the symmetric-canonicalization explanation and the "why some fields are disabled" note.

## Production audit SQL

The match-field config lives in `Sync.mappingsV2` (preferred) / `Sync.mappings` (v1
fallback when `mappingsV2 IS NULL`). Field **types/transformers in the schema live in git,
not the DB**, so SQL can only surface the **review population**: syncs whose match column
carries a transformer today (the set whose match-time behavior changes). Confirming which of
those actually regress requires reading each folder's `schema.json` (follow-up script).

**V2 mappings:**

```sql
WITH table_mappings AS (
  SELECT s.id AS sync_id, s."displayName", s."syncState",
         jsonb_array_elements(s."mappingsV2" -> 'tableMappings') AS tm
  FROM "Sync" s
  WHERE s."mappingsV2" IS NOT NULL
)
SELECT t.sync_id, t."displayName", t."syncState",
       t.tm -> 'recordMatching' ->> 'sourceColumnId'      AS source_match_col,
       t.tm -> 'recordMatching' ->> 'destinationColumnId' AS dest_match_col,
       m.match_col_mapping -> 'source' -> 'transformer'  AS match_col_transformer,
       m.match_col_mapping -> 'source' -> 'transformers' AS match_col_transformers
FROM table_mappings t
LEFT JOIN LATERAL (
  SELECT cm AS match_col_mapping
  FROM jsonb_array_elements(t.tm -> 'columnMappings') AS cm
  WHERE cm ->> 'destinationColumnId' = t.tm -> 'recordMatching' ->> 'destinationColumnId'
    AND cm -> 'source' ->> 'columnId' = t.tm -> 'recordMatching' ->> 'sourceColumnId'
) m ON true
WHERE t.tm -> 'recordMatching' IS NOT NULL
  AND ( m.match_col_mapping -> 'source' -> 'transformer'  IS NOT NULL
     OR m.match_col_mapping -> 'source' -> 'transformers' IS NOT NULL );
```

**V1 mappings (only where `mappingsV2 IS NULL`, since v2 wins when present):**

```sql
WITH table_mappings AS (
  SELECT s.id AS sync_id, s."displayName", s."syncState",
         jsonb_array_elements(s."mappings" -> 'tableMappings') AS tm
  FROM "Sync" s
  WHERE s."mappingsV2" IS NULL
)
SELECT t.sync_id, t."displayName", t."syncState",
       t.tm -> 'recordMatching' ->> 'sourceColumnId'      AS source_match_col,
       t.tm -> 'recordMatching' ->> 'destinationColumnId' AS dest_match_col,
       m.match_col_mapping -> 'transformer'  AS match_col_transformer,
       m.match_col_mapping -> 'transformers' AS match_col_transformers
FROM table_mappings t
LEFT JOIN LATERAL (
  SELECT cm AS match_col_mapping
  FROM jsonb_array_elements(t.tm -> 'columnMappings') AS cm
  WHERE cm ->> 'destinationColumnId' = t.tm -> 'recordMatching' ->> 'destinationColumnId'
    AND cm ->> 'sourceColumnId'      = t.tm -> 'recordMatching' ->> 'sourceColumnId'
) m ON true
WHERE t.tm -> 'recordMatching' IS NOT NULL
  AND ( m.match_col_mapping -> 'transformer'  IS NOT NULL
     OR m.match_col_mapping -> 'transformers' IS NOT NULL );
```

Run read-only via `terraform/tools/connect_to_gcp_db_readonly.sh production "<sql>"`.

- **Empty result** ⇒ no live sync relies on a match-column copy transformer; the change is
  behavior-preserving for matching and purely fixes the broken object-valued direction.
- **Non-empty** ⇒ inspect each: a transformer equal to the field's connector-suggested
  unpack is a no-op under the new rule (safe); a hand-rolled `jsonpath`/other transformer
  needs a per-sync judgment.

**Optional deeper audit (out of band):** a Node script that, for each sync with
`recordMatching`, reads both folders' `schema.json` from git and reports the match column's
`type` + `x-scratch-suggested-transformer` on each side — this is what actually proves
"newly matchable" (object field gains an extractor) vs "newly unmatchable" (object field
with no extractor). SQL alone cannot, because the schema isn't in Postgres.

## Test plan

- **Unit (`deriveCanonicalMatchKey`)**: primitive passthrough; number↔string coercion;
  Notion `rich_text` object → inner string via suggested transformer; object with no
  suggested transformer → null; suggested transformer that yields non-primitive → null;
  empty/whitespace → null.
- **Unit (`getMatchFieldCompatibility`)**: primitive types usable; object + extractor
  usable; object without extractor not usable.
- **Integration (`sync.service`)**: Postgres→Notion and Notion→Postgres both match on the
  same id; Pass 3 classification (`matched` / `withMatchKey` / `withoutMatchKey`) from
  canonical destination rows; a previously-passing copy-transformer sync still matches.
- **Client**: incompatible pair rendered disabled with reason; compatible pair selectable.

## Rollout

1. Land server reducer + rewire + tests (behind no flag — matching is internal and
   idempotent; a re-run re-derives keys cleanly).
2. Land shared predicate + editor disabling.
3. Run the audit SQL on production **before** deploy; review any non-empty result.
4. Update `server/src/sync/README.md` + external docs page.
```
