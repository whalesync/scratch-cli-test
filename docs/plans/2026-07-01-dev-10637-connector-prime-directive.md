# Array-keyed editable columns (kill the pull-time array→object reshape)

**Status:** Copper slice complete (all layers built + tested; desktop QA pending) · **Issue:** DEV-10637 (Connector Prime Directive) · **Branch:** `DEV-10637-connector-prime-directive` · **Date:** 2026-07-01

This branch is the **Copper slice** (the first of DEV-10637). It builds the reusable
array-keyed-columns primitive and migrates Copper off its reshape. Remaining DEV-10637
slices (own PRs): GoHighLevel, Affinity (same array reshape); Shopify (SEO/image synthesis);
Postgres/Supabase (NUMERIC coercion); the additive-FK ruling; and the CI verbatim-fidelity guard.

## Done in this slice

- `@spinner/shared-types` `keyed-array.ts` — annotation, `parseFilterSegment`, `coerceFilterValue`,
  `findKeyedArrayElement`, `diffKeyedArrayElements`, `getArrayKeyedByOptions`, path builders + unit tests.
- Server `computeChangedFields` — schema-aware element-wise keyed-array diff (sparse `[{keyField,…}]`) + tests.
- Copper — verbatim array + `x-scratch-array-keyed-by` annotation; `copper-custom-fields.ts` reshape deleted
  (repurposed to metadata helpers); schema/view/connector updated; 37 server tests green; typecheck + lint clean.
- Desktop — `getByPath`/`setByPath` (co-located in `project-record.ts`) + `build-column-definitions`
  filter-segment support; 358 desktop tests green; build + lint + typecheck clean.
- Docs — `existing-connectors.md:101` rewritten; Copper `STATE.md` updated.

**Split for MRs (CLAUDE.md rule):** MR-A = shared-types + server (lands first, so the deployed
server serves the annotation); MR-B = scratch-desktop (lands after A deploys).

## Problem

Three connectors — **Copper**, **GoHighLevel**, **Affinity** — physically reshape an
array-of-`{id, value}` into a keyed object on **pull** and back to an array on **publish**
so each element becomes an individually editable, individually diffable table column
(`connector-build/existing-connectors.md:101`). This violates the product's prime
directive — *store the verbatim external API response on disk* — because the bytes in
git no longer match what the service returned. A `git clone → edit → push` round-trip
sees Scratch's invented shape, not Copper's.

The reshape exists only because Scratch's **editable column path is a plain-object
dot-path**: `getByPath`/`setByPath` treat arrays as leaves, and the schema column
builder recurses only into `type:'object'`. So an array element can never become a
column — unless the array is first turned into an object.

## Why the reshape was *needed* (what it solved)

Copper stores `custom_fields: [{ custom_field_definition_id, value }, …]`. Without the
reshape:
1. **No editable column** — `getByPath(rec, "custom_fields.700123.value")` bails at the
   array (arrays are leaves), so the user sees one opaque JSON blob, not one column per field.
2. **Writes silently dropped** — `setByPath` substitutes `{}` for an array segment, so an
   edit never round-trips.
3. **No per-field diff** — the whole array diffs atomically, so a one-field edit can't be
   isolated (this is also what powers Copper's read-only-edit detection, DEV-10597).

## Approach — one declarative annotation, verbatim array on disk

Add a schema annotation `x-scratch-array-keyed-by` on the array property. It carries the
element **key field**, the optional **value sub-path**, and the known **keys → columns**.
The generic engines consume it; the array stays verbatim on disk.

### Path grammar

Extend the dot-path with a **filter segment** `[<field>=<value>]`:

```
custom_fields.[custom_field_definition_id=700123].value
```

`"a.b".split(".")` already yields the filter segment as its own token, so the change is
localized: a segment matching `^\[(field)=(value)\]$` selects (read) or find-or-appends
(write) the array element whose `String(el[field]) === value`.

### Touch points

| Layer | File | Change |
|---|---|---|
| shared primitive | `packages/shared-types/src/connector/keyed-array.ts` (new) | annotation const, `ArrayKeyedByOptions`, `parseFilterSegment`, `coerceFilterValue`, `diffKeyedArrayElements` + tests |
| read (desktop) | `scratch-desktop/.../schema-columns/project-record.ts` `getByPath` | handle filter segment over arrays |
| write (desktop) | `scratch-desktop/.../workspace/FolderDataGrid.tsx` `setByPath` | find-or-append element on filter segment |
| columns (desktop) | `scratch-desktop/.../schema-columns/build-column-definitions.ts` | expand annotated array → N filtered-path columns |
| publish diff (server) | `server/src/publish-plan/diff-utils.ts` `computeChangedFields` | schema-aware: keyed arrays diff **element-wise** → sparse `[{keyField,…}]` |
| Copper | `copper-connector.ts`, `copper-json-schema.ts`, `copper-default-view.ts` | emit annotation, store verbatim array, **delete `copper-custom-fields.ts` reshape**, adapt read-only strip to array |

**Rust CLI is out of scope**: its `get_by_path` is used only for FK-path / id-path
extraction; there is no `set_by_path`. Copper custom fields are neither an FK nor an id,
so the CLI never addresses them.

### Value coercion

The filter value is a string in the path. On find/create, coerce digit-only values to
`number` (Copper ids) and leave everything else a string (GHL short-keys). Documented
limit: filter values may not contain `.` or `]`.

## Rollout

1. Copper first (simplest, cleanest key = immutable numeric `custom_field_definition_id`,
   already isolated behind pure functions + tests, live test account 612378).
2. Then GoHighLevel, then Affinity.
3. Update `connector-build/existing-connectors.md:101` to point at this primitive as the
   sanctioned pattern and retire the reshape guidance.

## Open questions

- Should the known-keys list live in the annotation (server enumerates at
  `fetchJsonTableSpec` time) or be discovered client-side from a sample? → **annotation**,
  mirroring how Copper already enumerates definitions for the schema.
- Single-record detail editor: confirm it shares `setByPath` (grid + detail parity).
