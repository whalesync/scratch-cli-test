# Live Export audit — PIPEDRIVE (source)

> One doc per SOURCE service; add a "Destination: X" section per destination audited
> (a multi-destination run — `/test-live-export <src> <d1>,<d2>` — appends one section each).
> Gates 1–5 are destination-independent (judge once); gates 6–12 are re-proved per destination.
> Every ✅ needs evidence ids (workbook / sync / routine-run / report path). No evidence, no ✅.

- Umbrella Linear issue: DEV-11029 (`Live Export QA: PIPEDRIVE source`, project [MAJOR] Live Export)
- Credentials: `local/audit-creds/pipedrive.env` (burner account: connector-build test account)
- OAuth-only? no — `apiKey` user_provided_params
- Seed script: `tools/live-export-audit/seeds/pipedrive/`
- Torture tables:
  - **deals** — every custom-field type (varchar, text, double, monetary, date, daterange, time,
    timerange, enum, set, address, phone, org, people), system monetary `value`, status enum,
    FKs → persons/organizations (exported) and stages/pipelines (NOT exported → dropped-FK case)
  - **persons** — email/phone multi-value arrays, birthday (empty-date sentinels), org_id FK,
    210 records (pagination)
  - **organizations** — address composite, unicode names, FK target
  - **leads** — v1 API: offset pagination, UUID ids, flat custom fields (shared with deals),
    `value: {amount, currency}` object, label_ids array
  - **notes** — v1 API: HTML rich-text `content`, FKs → deals/persons/organizations/leads,
    read-only hydrated stubs, PUT updates

## Gates

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Preflight (server, token, creds) | ✅ | preflight OK for all 3 dests 2026-07-23; wkb_LqX0bSOzoy (SUPABASE), wkb_u9vnwi5JXL (AIRTABLE), wkb_Kc3vKf3xaF (NOTION) plan-only probes |
| 2 | Recon: connector + View read, tables chosen | ✅ | pipedrive-connector.ts / -json-schema.ts / -static-schemas.ts / -types.ts read; tables per list above |
| 3 | Torture data seeded + read back via service API | ✅ | seed.mjs VERIFY OK 2026-07-23: 15 deals / 217 persons / 5 orgs / 4 leads / 5 notes; 18 fable_qa custom fields created |
| 4 | Plan audit: every downgraded field judged (finding or accepted) | ✅ | findings DEV-11032/-11033/-11034/-11035/-11036 + accepted list below; reports /tmp/audit-pipedrive-{supabase,airtable,notion}.json |
| 5 | FKs identified as foreignKey; links resolve on destination | ✅ | verified on all 3 dests (Supabase joins, Airtable multipleRecordLinks, Notion relations); stage_id/pipeline_id correctly DROPPED as not-in-export; plan-time "isn't in this plan" notes are misleading artifacts |
| 6 | First run: publish failures = 0 or all filed | ✅ | 251/251, failedOperations [] on all 3 (with `--skip-fields url`; the blocker without it = DEV-11030) |
| 7 | Destination-side spot check (≥3 records/table, via dest service API) | ✅ | per-destination sections below |
| 8 | CRUD pass: edit / create / delete mirrored | ⚠ | edits + create ✅ on all 3 (incl. >2000-char Notion edit); DELETE never mirrored on any dest → DEV-11031 |
| 9 | Pagination: 200+ record table fully synced (count matches) | ✅ | 219 persons exact on all 3 destinations (v2 cursor); leads/notes exercise v1 offset |
| 10 | Second run is a no-op | ❌ | Supabase 2/251 (float precision), Airtable 251/251 (empty-field omission), Notion 251/251 (rich_text normalization) → evidence commented on DEV-10556 |
| 11 | Destination drift: out-of-band delete restored (or fails loudly) | ⚠ | Supabase restored ✅ (rrn: "Published 3 changes"), Airtable restored ✅; Notion NOT restored — archived page refails loudly ("Can't edit block that is archived") → evidence commented on DEV-10957 |
| 12 | Findings filed (project + `live-export-qa` label) or queued below | ✅ | DEV-11029 (umbrella) + DEV-11030…11036; comments on DEV-10556, DEV-10957 |

## Findings

| Issue | Layer | Summary | Status |
|---|---|---|---|
| DEV-11030 | core | Default plan unsavable: `picture_id.url` union subfield (plan expands all anyOf branches, save resolver only first) — blocks Persons/Organizations; leaves junk empty destination tables | filed (Urgent) |
| DEV-11031 | transport | Source deletes never mirrored (Pipedrive soft-delete invisible to list pulls; no tombstone/absence detection) | filed (High) |
| DEV-11032 | transport | daterange/timerange schema shape wrong ({start_date,end_date} vs verbatim {value,until}) → dead subfield columns everywhere | filed (Medium) |
| DEV-11033 | view | No date typing — every date/datetime exports as text column on all destinations | filed (Medium) |
| DEV-11034 | view | enum/set export raw option ids; labels lost | filed (Medium) |
| DEV-11035 | view | emails/phones arrays land as concatenated JSON fragments; propose primary-pluck codec | filed (Medium) |
| DEV-11036 | view | Junk duplicate columns (custom_fields container, notes stubs, composite containers) | filed (Low) |
| DEV-10556 | core | Second run never a no-op — 3 mechanisms evidenced (Airtable empty-omission 251/251, Notion rich_text 251/251, Supabase float 2/251) | commented, not re-filed |
| DEV-10957 | dest-pack | Archived Notion page + field drift still refails as plain edit on branch incl. cb49ab273/d280bc20f | commented, not re-filed |

## Accepted downgrades (not bugs — text is the honest representation)

| Field | Type | Why accepted |
|---|---|---|
| label_ids (deals/persons/orgs/leads) | number[] → text | bare label ids; no label metadata pulled today — honest as text (could join labels later, low value) |
| notes content (HTML) → text | text | source value IS HTML; verbatim text is honest on Postgres/Airtable. A rich-text/MD transformer for Notion would be a nicety (generic story: DEV-10961 family) |
| picture_id → number | number | bare Pipedrive image id, read-only; nothing useful to display without an extra fetch |
| custom double 9007199254740993 → 9007199254740992 | number | inherent float64 (JSON parse) — unavoidable; the resulting CHURN is the bug (DEV-10556 comment) |
| Airtable tab → space in singleLineText | text | Airtable normalizes control chars — destination limitation |
| visible_to as number/text | mixed | Pipedrive visibility enum ids; honest |

## Pre-triage notes (destination-independent — judged on the first destination's plan)

- **[core] BLOCKER — default plan fails to save: `picture_id.url` subfield unresolvable.**
  First SUPABASE run (wkb_iTrGAYKdAO) died at save: `Validation failed for folder mapping:
  Source field 'picture_id.url' not found in schema`. Root cause: plan-side
  `extractSchemaPaths` (`server/src/utils/schema-helpers.ts:66`) iterates ALL non-null union
  branches, so Pipedrive's picture schema `Union[Number, Object({url}), Null]` yields a
  `picture_id.url` subfield column; save-side `getSchemaAtFieldPath` →
  `objectSchemaWithProperties` (`server/src/utils/field-path.ts:107-119`) unwraps only the
  FIRST non-null branch (Number → no properties) and rejects the mapping the plan itself
  generated. Persons AND Organizations both carry `picture_id` → the untouched default export
  of either table cannot be saved. Audit continues with `--skip-fields url` (equivalent to the
  user unticking the column in dusky).
- **[transport] daterange/timerange schema shape mismatch.** Verbatim v2 GET returns
  daterange as `{value, until}` and timerange as `{value, until, timezone_id, timezone_name}`
  (probed live on deal id 9), but `pipedrive-json-schema.ts` declares `{start_date, end_date}` /
  `{start_time, end_time}`. Write API also accepts only `{value, until}`. Consequence in plan:
  subfield columns `start_date`/`end_date`/`start_time`/`end_time` are DEAD (paths never exist
  in pulled data) while the real `{value, until}` lands only in the JSON-string container column.
- **[view] all date/datetime fields mapped as text.** add_time/update_time/expected_close_date/
  won_time/etc. → `mappedKind: text` in the plan. The plan generator promotes to real date
  columns only when the view declares `TablePropertyType 'date'` (`inferBaseLogicalFieldType`,
  `dateCreateFieldType` — schema-builder-plan-generator.ts); Pipedrive has no `buildDefaultView`
  override, so no date hints exist despite `format: 'date-time'` annotations in the schema.
- **[view] enum synced as raw option id (number), set as raw id array text.** fable_qa_enum →
  number column carrying the option id (e.g. `10`), not the label ("Opt, B"); set → JSON text of
  ids. Labels exist in the schema literals' `title`. Users get meaningless ids on the destination.
- **[view] emails/phones arrays downgraded to plain text** ("Can't unpack this Pipedrive array
  field") — samples hold `[{value, label, primary}]`; a codec plucking primary value (or joining
  values) would be strictly better.
- **[view] junk container/stub columns**: whole `custom_fields` object exported as one JSON text
  column alongside its unpacked subfields; notes' hydrated `organization`/`person`/`deal`/`lead`/
  `user` stubs exported as JSON text columns.
- Plan-time FK notes say "links to X, which isn't in this plan" even when X IS in the plan —
  expected harness/plan artifact (server binds `unresolvedLinkedTableId` at save); verify FKs
  actually resolve on the destination before judging.
- Seeding quirks (service behavior, not bugs): `birthday` write 403 unless contact sync enabled;
  set field rejects `[]` ("use null to clear"); `probability` write rejected unless enabled on
  pipeline; daterange/timerange writes must be `{value, until}`.

## Destination: SUPABASE

- Workbook: wkb_TXnltvTGLg · Sync: syn_whwTis4R5L · Report: /tmp/audit-pipedrive-supabase.json
- Runs: rrn_auRgGnbw2Y (initial, "Published 251 changes", failedOperations: []), rrn_wYgjptVGRd (second-run check)
- Aborted earlier attempts: wkb_iTrGAYKdAO (save blocked by picture_id.url — see [core] blocker),
  wkb_BfBk9dL5hd (shared :3010 server wedged under parallel-audit load; HeadersTimeout mid-save).
  This run used an isolated session server on :3011 (spinner-redis-1 / port 6380).
- Destination tables: `public."Deals 2" / "Persons 2" / "Organizations 2" / "Leads 2" / "Notes 2"`
  (the " 2" suffix because the ABORTED first attempt had already materialized empty
  `Deals/Persons/Organizations/Leads/Notes` tables before its save failed — destination junk from
  the materialize-before-validate sequencing, same gripe as DEV-10959).

### Verified on destination (Supabase SQL, 2026-07-23)

- Counts match source exactly: Deals 16, Persons 219 (**pagination gate ✅** — >200 via cursor
  pages), Organizations 6, Leads 4, Notes 6.
- **FKs resolve** (system + custom): deal_linked.org_id → fable_qa_org_alpha,
  .person_id → fable_qa_person_org; custom org/people FK columns hold correct destination UUIDs;
  leads (UUID ids) person/org FKs resolve; notes deal/person/org/lead FKs resolve. Plan-time
  "links to X, which isn't in this plan" notes are misleading plan-time artifacts only.
- Long text 2001 + 4500 chars intact; unicode (emoji/CJK/RTL/zero-width/quotes) intact in titles,
  names, note bodies; org custom text preserves newlines/tabs/entities.
- Lead v1 monetary `{amount,currency}` unpacked into amount/currency columns ✅.
- Monetary custom field: subfield columns (value 2/currency) populated ✅ + junk JSON container.
- Notes: verbatim HTML in text column (honest for Postgres); hydrated-stub columns are JSON text.
- Enum custom field → raw option id in a double-precision column (33/34); set → comma-joined id
  list text ("36, 37, 38") — labels lost (see [view] finding).
- daterange/timerange: container column holds raw `{"value":…,"until":…}` JSON; `start_date`/
  `end_date`/`start_time`/`end_time` subfield columns exist and are ALWAYS EMPTY (dead columns —
  [transport] shape mismatch).
- add_time/update_time/expected_close_date etc.: TEXT columns, not timestamptz ([view] date gap).
- emails/phones: comma-joined JSON fragments of each element in one text cell.

### Second-run check: NOT a no-op (churn finding)

rrn_wYgjptVGRd re-published 2 edits on unchanged data — both rewriting the custom double field:
`{aad0ed…: 0.3}` (source raw `0.30000000000000004`) and `{aad0ed…: 9007199254740992}` (source raw
literal `9007199254740993`). High-precision doubles don't survive the float64/destination
round-trip, so the diff re-plans the same edit forever. Idempotency violation; evidence for
DEV-10556-family churn. All other 249 records were stable no-ops.

## Destination: AIRTABLE

- Workbook: wkb_8klddX7Yqg · Report: /tmp/audit-pipedrive-airtable.json · Base appGoopxI4Px4dyuv
  ("Cetacean Invoicing", shared QA base) — tables created: `Deals 3` (tblxKZ4B147XWNVss),
  `Persons` (tblUpg6Ax8XSD3hrh), `Organizations` (tbls6g3EsPqQGXQXY), `Leads` (tbl70JbzXTd8DOWNY),
  `Notes 2` (tblj62RRGLxq8OPky) — " N" suffixes from other sources' leftovers in the shared base.
- First run: "Published 251 changes", failedOperations: [] ✅.

### Verified on destination (Airtable REST API, 2026-07-23)

- Counts: Deals 16, Persons 219 (**pagination ✅**), Notes incl. all 5 fable notes.
- FKs → `multipleRecordLinks` and resolve (deal_linked person_id/org_id hold rec ids; note→lead).
- Long text 2001/4500 intact (singleLineText accepts long values via API); unicode intact except
  `\t` normalized to space by Airtable (destination limitation, accepted).
- Same upstream signatures as Supabase (differential confirms NOT [dest-pack]): enum → raw option
  id number; set → comma-joined id text; daterange container raw JSON with dead
  `start_date`/`end_date` columns; add_time/update_time → singleLineText not date.

### Second-run check: NOT a no-op — TOTAL churn (all 251 records re-edited)

rrn (second) re-published **251/251 edits on unchanged data**, `failedCount: 0`. changedFields on
every operation re-send only EMPTY values — `""` for empty text (label_ids/phones/emails/
last_name/set), `null` for unset FK/number/select, `false` for checkboxes. Airtable's read API
OMITS empty fields from `fields`, so destination-pull sees them absent, the diff treats absent ≠
""/null/false, and every record with any empty field re-edits forever. Supabase (returns
""/null/false verbatim) churns only 2 records (float-precision case) — the differential isolates
this to empty-value equivalence in the diff vs Airtable read normalization. DEV-10556 family.

## Destination: NOTION

- Workbook: wkb_eFtvEb2LqY · Sync: syn_BznSPRJHGk · Report: /tmp/audit-pipedrive-notion.json
- Runs: rrn_RXTQmEInry (initial, "Published 251 changes", failedOperations: []),
  rrn_SVhKcp30HB (second-run check). Two earlier aborted attempts (wkb_OOZH9jb1Uk + one more)
  failed at repo init because the shared scratch-git service on :3100 was deadlocked (0% CPU,
  unresponsive ≥300s); restarted it (same env/cwd) and everything recovered — ops note, not a
  Pipedrive finding.
- Notion database "Deals" af9f0ae0-97cf-482a-a2b5-5d2ea5489ad7 (+ Persons/Organizations/Leads/
  Notes) under the QA parent page.

### Verified on destination (Notion API, 2026-07-23)

- 16 deals present; long text 2001 + 4500 chars intact as split rich_text spans (create-path
  splitting works — DEV-10955 concerns the edit path); unicode titles intact.
- FKs → real `relation` properties and resolve (deal_linked org_id/person_id REL:1).
- Same upstream signatures as Supabase/Airtable (differential → NOT [dest-pack]): enum → number
  property with raw option id; set → rich_text "36, 37, 38"; dates → rich_text; daterange
  container JSON + dead subfield columns.
- First run has zero rejections — DEV-10952/10953-style pack rejections don't bite this source
  because Pipedrive delivers numbers as real JSON numbers and everything composite was
  downgraded to text by the plan.

### Second-run check: NOT a no-op — TOTAL churn (251/251 re-edited)

Churned fields are the rich_text-packed JSON containers and datetime strings (`custom_fields`,
`update_time`, …): Notion normalizes rich_text on read-back (annotations/href added), so the
diff never converges. Same DEV-10556 family as Airtable but a distinct mechanism (rich_text
normalization vs empty-field omission).

## Retest 2026-07-24 (after 997b3a7c6 union-resolver + 1bf4e82bb default view)

Fresh workbooks on all three destinations: wkb_kPi2CwnW2e (Supabase, tables `… 2`),
wkb_IK4PSfAjE2 (Airtable, `Deals 5`/`Leads 3`/…), wkb_NZiklitVxi (Notion, db 2ad108fa…).
Source re-seeded to canonical state first. Reports /tmp/retest-pipedrive-*.json,
/tmp/crud2-pipedrive-*.json.

| Original finding | Verdict |
|---|---|
| DEV-11030 picture_id.url save blocker | **FIXED** — default plan saves with zero skipped fields on all 3 |
| DEV-11032 daterange/timerange shape | **FIXED** — `(Value)`/`(Until)` real date/text columns, populated |
| DEV-11033 dates as text | **FIXED (dynamic entities)** — timestamptz/dateTime/date everywhere; residual: leads/notes static schemas lack `format` → still text → DEV-11043 (Low) |
| DEV-11034 enum/set raw ids | **FIXED** — labels export ("Opt, B", joined set labels) |
| DEV-11035 emails/phones JSON fragments | **FIXED (persons)** — comma-joined values; but see DEV-11042 regression |
| DEV-11036 junk columns | **FIXED** — containers + notes stubs hidden; nice display names throughout |
| DEV-11031 deletes never mirrored | **STILL BROKEN** — round-2 delete (deal 18) mirrored nowhere |
| DEV-10556 churn | **WORSE on Supabase** — 242/251 now churn (datetime string vs timestamptz repr); Airtable/Notion ~full churn unchanged |

New findings from the retest:

| Issue | Layer | Summary | Status |
|---|---|---|---|
| DEV-11042 | transport | **REGRESSION (Urgent)**: custom phone field is a bare string; schema+view treat it as array → jsonpath codec throws → ENTIRE Deals sync aborts (no publish at all) on every destination. Retest continued with `--skip-fields fable_qa_phone` | filed |
| DEV-11043 | transport | leads/notes static schemas missing `format: 'date-time'` → their date columns still text | filed (Low) |
| DEV-11044 | core | Invalid source date `"2026-02-29"` (Pipedrive stores unvalidated) permanently rejects the record on all 3 destinations, refails every run | filed (Medium) |

CRUD round 2 (with phone skipped): edits + create mirrored on all 3 ✅ (incl. long-text edit),
delete still not mirrored ❌. First-run publish: 250/251 on each destination (the 1 = DEV-11044
invalid-date lead).

## Human remainder (not automatable — do before launch)

- [ ] OAuth connect flow in real UI (Pipedrive supports OAuth)
- [ ] Full dusky wizard pass: placeholders, field-picker warnings, run from UI
- [ ] Sign-off on proposed View changes

## CRUD + drift details (Phase 4, 2026-07-23)

- Source CRUD via `tools/live-export-audit/seeds/pipedrive/crud.mjs --round 1`: edited
  fable_qa_deal_longtext_2001 (appended `[crud-r1]` to the 2001-char text) + person_emails3
  (rename + primary email), created fable_qa_deal_crud_created_r1, deleted fable_qa_deal_lost.
- Replays: Supabase publish 1c/4e/0d (2 of the edits are float churn); Airtable 1c/251e/0d;
  Notion 1c/251e/0d — all failedCount 0. Edits + create verified on each destination's API;
  the Notion >2000-char EDIT succeeded (DEV-10955 edit-path split fix works on this branch).
- Delete NOT mirrored anywhere → DEV-11031.
- Drift (out-of-band destination delete of fable_qa_deal_won): Supabase row deleted via SQL →
  restored on rerun ✅; Airtable record deleted via API → restored ✅; Notion page archived →
  NOT restored, publish rejects the planned edit loudly (DEV-10957 comment).

## Log

- 2026-07-23 — claude (/test-live-export pipedrive supabase,airtable,notion) — audit started; preflight passed for all 3 destinations; recon done; tables chosen.
- 2026-07-24 — claude — RETEST after fixes (997b3a7c6 + 1bf4e82bb): DEV-11030/11032/11034/11036 fixed, DEV-11033 fixed for dynamic entities, DEV-11035 fixed for persons; found Urgent regression DEV-11042 (custom phone string vs array codec aborts Deals sync) + DEV-11043/11044; DEV-11031 still broken; Supabase churn worsened to 242/251 (datetime repr — DEV-10556 comment). Fix verdicts commented on every issue.
- 2026-07-23 — claude — seeded torture data (15 deals / 217+ persons / 5 orgs / 4 leads / 5 notes, 18 custom fields); found + filed DEV-11030 save blocker; ran all three destinations on isolated session server :3011 (shared :3010 was wedged by parallel audits; also restarted a deadlocked shared scratch-git on :3100); CRUD + drift passes done; filed DEV-11029…11036, commented DEV-10556 + DEV-10957; doc closed out.
