# Generic display transformers — keep connector knowledge out of the desktop

- **Created:** 2026-06-02
- **Status:** Resolved
- **Author:** Curtis Fonger
- **Linear:** _not yet filed_ — follow-up to the resolved [Notion schema envelope fix](resolved/2026-06-02-notion-schema-envelope-fix.md)
- **Reviewed:** eng review complete (10 decisions locked, outside-voice pass via Claude subagent — 6 missed issues caught and folded in)

## Problem

To render Notion `title` / `rich_text` cells as readable text instead of raw span JSON, the desktop grid currently calls `flattenNotionRichText` (`scratch-desktop/src/shared/schema-columns/format-cell.ts`), which hard-codes Notion's span shape (`{ plain_text }`). That is the **first and only piece of connector-specific knowledge in the desktop renderer** — everything else is connector-agnostic.

This violates the intended boundary: **the desktop app should have zero knowledge of any specific connector.** Notion is the worst offender today; Attio is close; more connectors will need value-shaping for display. We do not want `if (notion) …` branches in the renderer.

## Principle / target architecture

- **The desktop renders only the generic view contract.** Everything connector-specific is computed on the **server** and expressed declaratively in the **view definition** the desktop fetches.
- The view is **expanded** to carry a declarative display instruction (a narrow transformer config) — value-shaping as data, not code.
- We **reuse the JSONPath machinery** the connector already uses for sync. The Notion title already declares `$.title[*].plain_text` (concat) as a sync virtual field; the same kind of declaration drives display.

Net: the connector says *how* to derive a cell's display value; the renderer just runs the declared transformer through a generic, fail-closed applier. The renderer never names a connector or a connector's field.

## Decisions (locked in eng review)

- **D1 — Fold the applier into `packages/shared-types`, no new package.** shared-types is already a runtime package (`class-transformer`, `lodash`, `nanoid`, … + runtime exports like `TransformerTypes`), so it is a natural home. Server and desktop both import the shared applier → DRY, single source for the pure JSONPath eval.
- **D2 — Server view-gen sets `displayTransformer` explicitly for `title`/`rich_text`.** No auto-derive-from-virtual-field string surgery (brittle). The column `path` stays drilled to the array (`properties.<name>.<typeKey>`), so the expression is array-relative: `$[*].plain_text`, `arrayHandling: 'concat'`.
- **D3 — Grid `displayData` only.** Detail view and cell popover keep raw JSON for now (their value is coupled to the editor / `acceptGridCellChange`; safely flattening them needs splitting display value from edit/accept value — deferred).
- **D4 — Subpath export `@spinner/shared-types/transform`.** The runtime applier (and its `jsonpath-rfc9535` import) is **NOT** re-exported from the barrel `index.ts`. An `exports` map maps `"."` (barrel, unchanged) and `"./transform"`. Server + desktop import the subpath; the Next.js client never pulls `jsonpath-rfc9535` (2.2M unpacked) into its bundle. Safe: zero deep imports of shared-types exist today, and all consumers use `nodenext`/`bundler` resolution which honor subpath + `types` conditions.
- **D5 — No per-cell perf optimization.** The grid is virtualized and only columns carrying a `displayTransformer` pay any cost; `$[*].plain_text` parses in microseconds. Memoization is a watch-item, added only if profiling shows jank.
- **D6 — Narrow `DisplayTransformerConfig` type, NOT the full `TransformerConfig`.** The full 23-arm union carries server-only arms (`lookup_field`, `source_fk_to_dest_fk`, `match_asset_by_hash` — `DataFolderId`/`Service`/`LookupTools`-bound) that the desktop cannot and must not execute and that are unsafe to serialize onto a view. The view field is typed as a small whitelist:
  ```ts
  type DisplayTransformerConfig = { type: 'jsonpath'; options: JSONPathOptions };
  // extensible later (trim/slugify); never the lookup/asset/FK arms.
  ```
- **D7 — The display applier fails CLOSED.** Unlike the sync transformer's `concat` (which drops missing-key spans and stringifies `null` → the literal `"null"`), `applyDisplayTransformer` returns `{ ok: false }` whenever the rich-text shape is unexpected (a span missing a string `plain_text`, a `null`, a non-array, an unsupported type, or a thrown error). The caller then shows the **raw JSON**, never a lossy/`"null"` string. This honors *Surface failures, never silently succeed*.
- **D8 — Do NOT refactor the server transformer to delegate.** Sharing is limited to the **pure** `query(value, expression)` wrapper. The server's `jsonpath.transformer.ts` keeps its own `useOriginal` / string-JSON-parse / error-result adapter (sync-pipeline semantics the display path must not inherit). This kills the "delegation isn't behavior-preserving" risk and avoids touching a shipped sync transformer.
- **D9 — Prove the subpath in a BUILT server before relying on it.** `yarn build` then load the server entry (`node`/`nest start` smoke) to confirm `@spinner/shared-types/transform` resolves at runtime under `nodenext` + `type: module` consuming shared-types' CommonJS output. Type-check passing is not sufficient.
- **D10 — Gate flattening on `displayTransformer` presence only; no transitional `type==='richtext'` fallback.** This work ships as one branch (the `richtext`/`flattenNotionRichText` interim commit is not deployed), so there is no live stale-view population. Views regenerate on re-pull (the established rollout model). `type: 'richtext'` is dropped as load-bearing (kept only as a cosmetic hint if useful).

## Architecture / data flow

```
Notion API page
      │  pull (verbatim envelope, stored on disk)              ← unchanged
      ▼
record.json:  properties.Name.title = [ {plain_text:"Ben Tossell", ...}, ... ]
      │
      ▼  view generation — SERVER (notion-default-view.ts)
TableViewCol {
   path: "properties.Name.title",                             ← drilled to the array
   displayTransformer: { type:'jsonpath',
                         options:{ expression:'$[*].plain_text',
                                   arrayHandling:'concat' } }   ← declarative, connector-set
}
      │  view stored + fetched by desktop (NO connector code in desktop)
      ▼  desktop grid — resolveDisplayString(value, viewCol) in getCellContent
val = getByPath(record, "properties.Name.title")              → the span array
displayData = applyDisplayTransformer(col.displayTransformer, val)   // fail-closed
                ?? toDisplayString(val)                       ← raw JSON if {ok:false}
data / copyData / accept = raw                                ← verbatim, untouched
      ▼
cell shows  "Ben Tossell"

SHARED CORE — packages/shared-types/src/transform/   (subpath: @spinner/shared-types/transform)
   apply-jsonpath.ts   query(value, expr)   ← wraps jsonpath-rfc9535, PURE, sync
   apply-display.ts    applyDisplayTransformer(DisplayTransformerConfig, value)
                          → {ok:true, value:string} | {ok:false}   (fail-closed)
         ▲                              ▲
         │ shares ONLY pure query        │ imports the subpath
   server jsonpath.transformer.ts        scratch-desktop resolveDisplayString
   (keeps its OWN useOriginal /          (display-only; data/copy stay raw)
    string-parse / error adapter — D8)
```

## Change plan (files)

1. **`packages/shared-types/src/transform/apply-jsonpath.ts`** (new) — sync `applyJsonPath(value, options)` wrapping `jsonpath-rfc9535` `query`. Pure.
2. **`packages/shared-types/src/transform/apply-display.ts`** (new) — `applyDisplayTransformer(config: DisplayTransformerConfig, value)`, fail-closed (D7). Plus the `DisplayTransformerConfig` type (D6).
3. **`packages/shared-types/package.json`** — add `jsonpath-rfc9535` dep + `exports` map with `"."` and `"./transform"` (D4). `index.ts` does **not** export the transform module.
4. **`packages/shared-types/src/connector/table-view.ts`** — add `displayTransformer?: DisplayTransformerConfig` to `TableViewCol`.
5. **`server/src/sync/transformers/implementations/jsonpath.transformer.ts`** — refactor only the pure query call to import `applyJsonPath` from the subpath; keep the existing `useOriginal`/parse/error adapter (D8).
6. **`server/.../notion-default-view.ts`** — set `col.displayTransformer` for `title`/`rich_text` (D2); drop `RICH_TEXT_TYPES → 'richtext'` as load-bearing (D10).
7. **`scratch-desktop/.../FolderDataGrid.tsx`** — extract pure `resolveDisplayString(value, viewCol)`; gate on `viewCol.displayTransformer` presence; apply to `displayData` only; keep `data`/`copyData` raw. Delete the `colType === 'richtext'` branch.
8. **`scratch-desktop/.../format-cell.ts`** — delete `flattenNotionRichText` + its export.
9. **Barrel-guard (D4 hardening)** — a unit/lint check that the transform runtime module is not reachable from `shared-types` `index.ts` (keeps the bundle-isolation invariant from silently breaking).

## Test plan

```
SHARED CORE (packages/shared-types/src/transform/__tests__)
  applyJsonPath:
    • concat across spans → joined plain_text            ← REGRESSION-CRITICAL
    • first / array / join_space / join_comma
    • null/undefined value; string→JSON.parse ok + fail
    • invalid expression → error; join over objects → error
  applyDisplayTransformer (FAIL-CLOSED, D7):
    • jsonpath over a clean span array → {ok:true, "Ben Tossell"}
    • span with plain_text:null or missing → {ok:false}   ← no "null", no silent drop
    • non-array / unsupported type / thrown → {ok:false}
  PARITY: same (value,options) through the server transformer's query path and
    applyJsonPath → identical (no-drift guard for the shared pure query)

SERVER (notion-default-view.spec.ts)
  • title & rich_text columns carry the expected displayTransformer
  • non-rich-text columns carry none
SERVER (jsonpath.transformer.spec.ts) — existing suite stays GREEN after the
  query extraction (regression gate for the shipped sync transformer)

DESKTOP (resolveDisplayString unit tests)
  • col with displayTransformer over span array → flattened   ← REGRESSION-CRITICAL
  • col without displayTransformer → toDisplayString fallback
  • applyDisplayTransformer {ok:false} → toDisplayString (raw JSON) fallback
  • data / copyData stay RAW when a displayTransformer is present (explicit assertion)

REMOVED: flattenNotionRichText + its format-cell.test.ts cases
```

## Failure modes

- **Malformed rich-text span (missing/`null` `plain_text`)** → D7 fail-closed → raw JSON shown (not `"null"`, not silently dropped). Test: applyDisplayTransformer fail-closed cases. Error handling: yes. User sees: raw JSON (honest), not a lie.
- **`inferCellKind` diverts a richtext column to Number/Boolean/Uri** (value resolves as a scalar) → flatten only runs in the Text branch, so it silently no-ops for that cell. Pre-existing limitation (the interim hack had it too). Documented; acceptable since the value genuinely isn't a span array. Not a critical gap (no data loss, value still shown).
- **Subpath fails to resolve in the built server** → caught by D9 build smoke before merge, not at runtime in prod.
- **Stale local view (no displayTransformer)** → column shows raw JSON until re-pull regenerates the view. Expected per D10 (re-pull model); not a prod regression (ships as one branch).

## Rollout

Views regenerate on the next pull of each Notion folder (same model as the envelope fix). No transitional fallback (D10). Ship the whole branch together.

## NOT in scope

- **Detail view + cell popover flattening** (D3) — their value is editor/accept-coupled; safe flattening needs a display/edit value split. Follow-up.
- **Auto-derive `displayTransformer` from `x-scratch-virtual-fields`** (D2) — brittle expression re-anchoring; revisit once a second connector needs it.
- **Per-cell memoization of JSONPath** (D5) — premature; virtualization + the presence-gate bound the cost. Watch-item.
- **Web client display transformers** — the Next.js client doesn't render this grid today; when it does, it imports the same subpath.
- **Generalizing beyond `jsonpath`** in `DisplayTransformerConfig` (D6) — add `trim`/`slugify`/etc. only when a real column needs them.
- **Refactoring the server sync transformer to delegate** (D8) — explicitly avoided; only the pure query is shared.

## What already exists (reused, not rebuilt)

- `TransformerConfig` / `JSONPathOptions` / `TransformerTypes` in shared-types (runtime) — `DisplayTransformerConfig` reuses `JSONPathOptions`.
- `jsonpath-rfc9535` + the eval semantics in `server/.../jsonpath.transformer.ts` — shared via the pure `query` wrapper.
- The `TableView`/`TableViewCol` contract the desktop already consumes; glide-data-grid's existing `displayData` vs `data`/`copyData` split (display-only is free).
- The Notion title's existing sync virtual field (`$.title[*].plain_text`, concat) — the display expression mirrors it (array-relative).

## Parallelization

Sequential implementation, no parallelization opportunity — shared-types (the applier + type + exports) is the foundation every other change depends on. Order: shared-types core+type+exports → server view-gen + transformer query extraction → desktop resolveDisplayString + delete hack → tests throughout.

## Implementation tasks

| # | P | Component | Task |
|---|---|---|---|
| T1 | P1 | shared-types | `DisplayTransformerConfig` (D6) + `displayTransformer?` on `TableViewCol`; `apply-jsonpath.ts` (pure) + `apply-display.ts` (fail-closed, D7); `exports` map + `jsonpath-rfc9535` dep; keep out of barrel (D4) |
| T2 | P1 | server transformers | Extract pure `query` use in `jsonpath.transformer.ts` to import `applyJsonPath`; keep adapter (D8); existing suite green |
| T3 | P1 | notion-default-view | Set `displayTransformer` for title/rich_text (D2); drop `richtext` as load-bearing (D10) |
| T4 | P1 | desktop renderer | Pure `resolveDisplayString`; gate on `displayTransformer`; `displayData` only; delete `flattenNotionRichText` |
| T5 | P1 | tests | shared-core unit + fail-closed + parity; view-gen; resolveDisplayString incl. data/copy-raw assertion; regression locks |
| T6 | P1 | verify | D9: `yarn build` + server runtime smoke that the subpath resolves; barrel-guard (D4) |

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 9 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **OUTSIDE VOICE:** Claude subagent (codex unavailable) — caught 6 issues the review missed: `concat` fails-open vs the old fail-closed flatten, `TransformerConfig` too broad/unsafe on a view column, server delegation not behavior-preserving, unverified subpath under nodenext+CJS/ESM, rollout window for stale views, and `inferCellKind` divert. All folded into decisions D6–D10 + failure modes.
- **CROSS-MODEL:** one tension (full transformer apparatus vs. extending `subfields` pluck) — user chose to keep the transformer approach with the outside-voice fixes applied.
- **UNRESOLVED:** 0
- **VERDICT:** ENG CLEARED — ready to implement.
