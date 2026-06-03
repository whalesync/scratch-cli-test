# Notion JSON Schema — describe the on-disk envelope

- **Created:** 2026-06-02
- **Status:** Planned
- **Author:** Curtis Fonger
- **Linear:** _not yet filed_ — related: [DEV-10308](https://linear.app/whalesync/issue/DEV-10308) (schema-free field writes; separate, complementary)
- **Reviewed:** eng review complete (4 decisions locked, outside-voice pass, 1 P1 caught)

## Problem

The Notion connector's generated JSON schema describes the **unwrapped** per-property value, but records on disk store the **raw Notion API envelope** `{ id, type, <typeKey>: value }`. Every Notion property mismatches its schema.

Confirmed against real on-disk artifacts (`~/Scratch Local/My Scratch workspace/Notion/`):

```
PROPERTY          SCHEMA SAYS                 RECORD ON DISK
Email             string | null               {"id":"%5DBMA","type":"email","email":"ben@tossell.com"}
Typical Check Size number | null              {"id":"AF%3CM","type":"number","number":25000}
Status (m-select) array<{id,name,color}>      {"id":"%40%5Ebf","type":"multi_select","multi_select":[{...}]}
Name (title)      array<span>                 {"id":"title","type":"title","title":[{...}]}
```

The schema is even self-contradictory: the `title` schema declares `type: array` yet carries a virtual-field JSONPath `$.title[*].plain_text` whose `$.title` prefix only resolves against the envelope. The JSONPath author knew the real shape; the structural type author did not.

## Root cause

The schema has described the unwrapped value since the first commit that introduced it (`57da2ac8`, 2026-01-27); the pull path always stored the raw envelope. This is a long-standing **schema-authoring bug**, not a regression and not a removed normalization step. The page-level envelope (`object`, `id`, `properties`, `url`, …) is described correctly — only the per-property values are wrong.

The **data is correct** per the repo principle *Preserve external data fidelity* (store raw API responses verbatim). Therefore the fix belongs in the **schema**, never the data. It went uncaught because no test ever validated a real on-disk record against the generated schema.

```
                        Notion API page
                              │
                  pull (stores VERBATIM envelope)        ← correct, do not touch
                              ▼
              record.json:  properties.Email = {id,type,email}
                              │
        ┌─────────────────────┼───────────────────────────┐
        ▼                     ▼                             ▼
  schema.json           default view                 extractSchemaFields
  says: string          path: properties.Email       (sync / agent context)
   ↑ WRONG               ↑ shows envelope JSON          ↑ pollutes once wrapped
   (the defect)          (the visible symptom)          (the hidden consumer)
```

## Decisions (locked in eng review)

- **D1 — Envelope fidelity: "faithful where it matters."** Generic `{id, type: Literal(type), [type]: value}` wrap, plus the structural extras real data carries (`relation.has_more`, `rollup.function`/`type`). Not exhaustive. TypeBox omits `additionalProperties`, so extra keys validate fine.
- **D2 — Default view: uniform one-level drill.** Every column drills exactly one level past the outer envelope. `formula`/`rollup` (doubly nested, read-only, result key not statically knowable) show their inner object; no fragile deep extraction.
- **D3 — Clean rewrite of `buildPropertyCol`.** Derive deterministically from the corrected schema; delete the `unwrapOptional` workaround and the dead `NOTION_TYPE_MAP → 'object'` fallbacks; guard the missing/unexpected-type edge.
- **D4 — Add the x-scratch leaf guard to `extractSchemaFields`** (`server/src/utils/schema-helpers.ts`). It recurses into `type:object + properties` unconditionally (unlike the desktop `walkProperties`), so envelope schemas would explode every scalar property into `properties.X.id/.type/.value` sub-fields and flip the type to `object`, polluting sync LLM mapping context, Whalesync import matching, and the MCP `get-folder-schema` tool. Mirror the desktop guard. (Fixes a latent server/desktop inconsistency.)
- **Annotation placement:** property-level annotations (`x-scratch-connector-data-type`, `-readonly`, `-remote-field-id`, `-virtual-fields`, and the relation `-foreign-key-options`) move onto the **outer envelope object**. This is load-bearing: `buildColumnDefinitions` (`build-column-definitions.ts:108-114`) treats an object **with** x-scratch metadata as a single leaf, so leaf/diff granularity is preserved. The relation FK field path consequently becomes `properties.<rel>` (was `properties.<rel>.relation`) — covered by a test.

## Change plan

### Before / after (schema for one scalar property)

```
BEFORE                                   AFTER
properties.Email:                        properties.Email:
  anyOf:[{type:string,format:email},       type: object
         {type:null}]                       properties:
  x-scratch-connector-data-type: email        id:    {type:string}
                                               type:  {const:"email"}
                                               email: {anyOf:[{string,email},{null}]}
                                             x-scratch-connector-data-type: email   ← outer
```

### Files

1. **`notion-json-schema.ts`** — `notionPropertyToJsonSchema` returns the envelope (D1). Annotations on the outer object. Normalize `relation` (currently half-wrapped, missing `type`; add `has_more`), `people`/`files` (array as inner value), `rollup`/`formula` (model both nesting levels). `buildNotionJsonTableSpec` unchanged except it now feeds the corrected schema to the view generator.
2. **`notion-default-view.ts`** — clean rewrite of `buildPropertyCol` (D2/D3): `path = properties.<name>.<type>`; subfields re-anchored to the inner value (`select`/`status` → `.name`, `date` → `.start`, people/arrays shown as arrays); missing-type guard → fallback `properties.<name>`.
3. **`server/src/utils/schema-helpers.ts`** — `extractSchemaFields` leaf guard (D4): skip recursion into an object that carries any `x-scratch-*` key. Verify non-enveloped connectors (HubSpot `properties`, Airtable `fields` — wrappers carry no x-scratch) still expand.

## Test plan

```
REGRESSION LOCK (the test that would have caught this — IRON RULE):
  Value.Check(record, generatedSchema) for:
    • a synthetic fixture with ONE property of every Notion type
      (must include relation.has_more, rollup, null select, people, files)
    • a real record (investor_crm/ben-tossell.json)

REWRITE:
  notion-json-schema.spec.ts   → assert envelope shape per type; annotations on outer object;
                                  relation.has_more + rollup modeled; null inner; unknown-type fallback
  notion-default-view.spec.ts  → assert path drilling + subfield re-anchoring + formula/rollup one-level
  schema-helpers (D4)          → assert Notion envelope property yields ONE field, not sub-fields;
                                  assert HubSpot/Airtable still expand; assert FK field-path = properties.<rel>

GUARDRAILS (keep green, no change):
  notion-connector-update-records.spec.ts   (raw-envelope write behavior)
  notion-connector-extract-assets.spec.ts   (asset extraction; confirms annotation-move safe)
```

## Failure modes

- **`buildPropertyCol` missing/unexpected `type`** → path `properties.<name>.undefined` → silent blank cell. Guard + test (T2).
- **Future Notion type** not in the switch → `default` → `Type.Unknown` envelope → renders as JSON. Graceful; covered by default-case test.
- **`extractSchemaFields` explosion** (pre-D4) → silent sync/agent-context degradation, no crash, no test catches it. Addressed by T6.
- **Rollout lag** → existing workspaces show JSON until re-pull regenerates. Not a regression.

## Verification (already confirmed in review)

- **Asset extraction safe:** `findAssetFieldOptions` (`asset-extraction-helpers.ts:257`) checks the top node first, so the annotation is found on the envelope; value resolution uses `unwrapNotionProperty` on record data, independent of placement. Page-level `cover`/`icon` untouched.
- **Rollout works on normal re-pull:** the pull job regenerates and rewrites the schema every run (`pull-linked-folder-files.job.ts:571/590`), plus create (`data-folder.service.ts:307/377`) and refresh (`:869/890`). No special action needed. One schema-only commit per Notion folder post-deploy (under `.scratch/`, never touches record files).
- Other annotation consumers ruled out: `x-scratch-virtual-fields` (envelope-relative JSONPath already), `-last-modified-field`/`-suggested-transformer` (top-level), null `select` rendering (`getByPath` returns `undefined` safely).

## Rollout

Deploy → users get the corrected schema + view on their next pull of each Notion folder. Consistent with the usual discard-and-refresh flow.

## NOT in scope

- **Schema-free field writes (DEV-10308)** — separate, complementary. This fix neutralizes the edit corruption (coercion resolves the correct inner type once paths drill); DEV-10308 is the robustness fix that makes writes immune to schema bugs entirely.
- **Validation tripwire / sync type-validator** — both stop being wrong as side effects; no work.
- **Deep formula/rollup scalar extraction** — D2 chose uniform one-level; result-value subfields are an opt-in fast-follow.
- **Exhaustive envelope-key modeling** — D1 chose faithful-where-it-matters.

## Implementation tasks

| # | P | Component | Task |
|---|---|---|---|
| T1 | P1 | notion-json-schema | Envelope-wrap each property; annotations on outer object; model real extras; normalize relation/people/files/rollup/formula |
| T2 | P1 | notion-default-view | Clean-rewrite `buildPropertyCol`; path drilling; subfield re-anchor; missing-type guard |
| T6 | P1 | schema-helpers | Add x-scratch leaf guard to `extractSchemaFields`; verify non-enveloped connectors expand; FK field-path test |
| T3 | P1 | notion `__tests__` | Regression lock: `Value.Check(all-types fixture + real record, schema)` |
| T4 | P2 | notion `__tests__` | Rewrite `notion-json-schema.spec.ts` + `notion-default-view.spec.ts` to envelope shape |
| T5 | P2 | verify | Keep extract-assets + update-records specs green; confirm pull-job regen |

Suggested order: T1 → T6 → T2 → T3 → T4 → T5. Sequential (view generator depends on the corrected schema; same module). No parallelization opportunity.
