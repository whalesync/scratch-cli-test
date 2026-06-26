<!-- Human-readable activity log for the Copper connector (see /connector-build-execute skill).
     STATE.md = what's covered; this file = what was done, in order. Append one line
     per operation. Coverage prior to 2026-06-10 predates this log and lives in STATE.md. -->

# Copper — Activity Log

## 2026-06-10 — custom-fields reshape + default view (Milestone 8)

Confirmed the view layer can't make array elements editable columns (root of the reshape decision):
[00:50:00] [Manual Edits] Verified in code that Scratch column paths are dot-path only — `getByPath` (scratch-desktop/.../project-record.ts) treats arrays as leaves; `setByPath` (FolderDataGrid.tsx) substitutes `{}` for an array segment, so edits into an array don't round-trip. Schema auto-columns recurse only into `type:'object'`. ⇒ an array of `{id,value}` must be reshaped to a keyed object to be per-element editable.

Reshaped custom_fields array ↔ keyed object (mirrors GoHighLevel; keyed by definition id):
[00:55:00] [Manual Edits] New copper-custom-fields.ts — reshapeCustomFieldsArrayToObject (pull/response: `[{custom_field_definition_id,value}]` → `{cf_<id>: value}`) + reshapeCustomFieldsObjectToArray (publish: back to the array) + customFieldColumnKey/parseCustomFieldColumnKey. Key = `cf_<id>`: rename-stable (Copper has no field slug), collision-free, path-safe; trivial reverse map so neither direction needs the definition list.
[00:56:00] [Manual Edits] copper-json-schema.ts — custom_fields is now a keyed object (one typed sub-property per definition via buildCustomFieldsObjectProperty); Connect/computed sub-fields marked x-scratch-readonly; agent legend moved to the schema ROOT (cf_<id>→name/type/options); removed the old verbatim-array helper.
[00:57:00] [Manual Edits] copper-connector.ts — reshape on pull (pullRecordFiles + pullRecordFilesByIds: array→object) and on publish (create/update: body object→array; response array→object so the persisted file keeps the editable shape + new id flows back).

Built the default view (Milestone 8):
[00:58:00] [Manual Edits] New copper-default-view.ts — buildCopperDefaultView: system fields flat (record id first, snake_case→Title Case labels, readonly from x-scratch-readonly), custom fields grouped under a "Custom Fields" banner (path `custom_fields.cf_<id>`, type from data_type, readonly from the schema sub-property). Wired into buildCopperJsonTableSpec.
[01:00:00] [Scratch CLI] Verified — eslint clean + tsc --noEmit 0 errors + jest: 59 passed across copper/ + zoho/ (new copper-custom-fields.spec.ts, copper-default-view.spec.ts; updated copper-json-schema.spec.ts; connector spec still green). Desktop banner/column confirmation deferred to the live pass.

## 2026-06-10 — live validation (pull-reshape + view generation) + gate hit

Confirmed the reshape + view work against the running branch server (no code changes):
[13:05:00] [Scratch CLI] Re-pulled Companies (dfd_jmWZXP7Tbk) + People (dfd_3oPfdMnzEJ) on wkb_lsWnc2smsb — scratchmd linked pull … --mode full. On-disk `custom_fields` went `[]` → `{}` (reshape-on-pull confirmed live; server has the branch code).
[13:06:00] [Scratch CLI] Verified generated view — local/cli-v4/Copper/Copper/.scratch/Companies/views/default.json: system fields flat, id first (readonly), interaction_count/date_created/date_modified readonly; "Custom Fields" banner correctly omitted (account has 0 custom fields).
[13:07:00] [Service API] Checked custom-field definitions — GET /custom_field_definitions → 0 defined. Copper field *definitions* are UI-only (no API create) → seeding needs a Copper web login.

Attempted a People Edit→Push (non-Companies write coverage) — blocked by the GCS gate:
[13:12:00] [Manual Edits] Set People/dadad.json title = "QA Test Title 0610" (Copper/People/dadad.json).
[13:13:00] [Scratch CLI] files accept OK, but `files upload` → 500 (upload-patch init failed).
[13:14:00] [Scratch CLI] Diagnosed: gcloud impersonation of GCS_LOCAL_SIGNING_SA fails to refresh ("Please run gcloud auth login") → the GCS signing/reauth gate, NOT a connector bug. Blocks ALL CLI publish (Copper + Zoho).
[13:23:00] [Scratch CLI] Reverted the edit — files discard "Copper/People/dadad.json" (title back to null, unpublished empty). Paused for the user to reauth gcloud + log into Copper.

## 2026-06-10 — live custom-field reshape round-trip (Milestone 8 + 4b) + key findings

People Edit→Push (non-Companies write coverage) — green-✅ standard:
[13:40:00] [Manual Edits] People/dadad.json title="QA Engineer 0610", details="Edit→Push round-trip test".
[13:41:00] [Scratch CLI] files accept/upload/publish → Published 1 connection; unpublished empty (after the gcloud reauth + server restart).
[13:42:00] [Service API] Confirmed in Copper — GET /people/183382759 → title+details landed ✅.

FINDING: Copper API CAN create custom-field definitions (contradicts the UI-only assumption):
[13:45:00] [Service API] POST /custom_field_definitions → 200. Seeded 10 types via API: String 751653, Text 751654, Dropdown 751655 (Alpha/Beta/Gamma), MultiSelect 751656 (Red/Green/Blue), Date 751657, Checkbox 751658, Float 751659, URL 751660, Currency 751661, Percentage 751662. Connect → 422 "Invalid data type 'Connect'" (UI-only; read-only in connector anyway).
[13:48:00] [Scratch CLI] Re-pulled Companies → view now has a populated "Custom Fields" banner (10 cols, correct names+types: MultiSelect→object, Checkbox→checkbox, Float/Currency/Percentage→number, URL→url); record custom_fields reshaped `[]`→`{cf_<id>: ...}` with real values ({cf_751656:[], cf_751658:false, ...}).

FINDINGS via direct-PUT bisect (diagnosing a silent publish fail):
[13:52:00] [Service API] custom_fields write rejected only for Date as ISO string → 422 "Data integrity error" (fails the WHOLE record). Copper Date custom field wants a UNIX TIMESTAMP (epoch s); 1781481600 → 200. All 9 other types accept their shapes (Dropdown=option id number, MultiSelect=array of option ids, Checkbox=bool, Float/Currency/Percentage=number, URL/String/Text=string).
[13:53:00] [Service API] Copper PUT MERGES custom_fields by definition id (10 single-field PUTs all survived) → connector sparse per-field update is SAFE.

Connector publish round-trip — all 10 writable types (green-✅ standard):
[13:56:00] [Manual Edits] Companies/dadas.json (id 76645470) custom_fields set to distinct CLI values + epoch Date.
[13:57:00] [Scratch CLI] files accept/upload/publish → Published; unpublished empty.
[13:58:00] [Service API] GET /companies/76645470 → 10/10 custom-field types match the connector-published values ✅.
[13:59:00] [Scratch CLI] Re-pulled → read-back round-trip clean (all 10 reload under cf_<id> with full fidelity).
[14:01:00] [Manual Edits + Scratch CLI + Service API] Merge test: edited ONLY cf_751659 (Float)→12.34 via CLI publish → Copper shows Float 12.34 and the other 9 unchanged (9/9) → keyed-object per-field diff + Copper merge confirmed end-to-end.

## 2026-06-10 — Companies New/Delete→Push + FK re-parent move (4a)

[14:10:00] [Manual Edits + Scratch CLI] New→Push: wrote Companies/qa-new-co-0610.json (no id, name+email_domain+2 custom fields) → accept/upload/publish → Copper id 76733974 flowed back into the file.
[14:11:00] [Service API] Confirmed create — GET /companies/76733974 → name + email_domain + custom_fields (751653,751659) all landed ✅.
[14:13:00] [Scratch CLI + Service API] Delete→Push: rm the file → accept/upload/publish → GET /companies/76733974 → 404 ✅ gone.
[14:18:00] [Manual Edits + Scratch CLI + Service API] FK re-parent: dadas (76645470) primary_contact_id moved B(183582749)→C(183582757, fresh person) via CLI publish → confirmed C in Copper API; unpublished empty.
[14:20:00] [Service API] Found Copper's related-person rule: setting primary_contact_id to dadad (183382759, tied to another company) → 422 "Data integrity error" on the raw API PUT too (Copper rule, not connector); the connector correctly left the failed write in files unpublished. Documented in STATE Gotchas + the general playbook.

## 2026-06-10 — all-entity CRUD + edge cases (4d)

Edge cases on Companies/dadas.json (76645470):
[14:30:00] [Manual Edits + Scratch CLI + Service API] Set details/custom String with 🎯 emoji + テスト/ünïcödé, a 2006-char custom Text, and a tags array → publish → Copper API read-back: emoji + unicode + long string + tags ALL survive (utf8mb4; opposite of Zoho's emoji→?).

Per-entity CRUD for the 4 remaining entities (Leads/Opportunities/Tasks/Projects):
[14:36:00] [Manual Edits + Scratch CLI] New→Push minimal `name`-only records → all 4 created, remote ids flowed back (Leads 94197062, Opp 38357247, Task 59108940, Project 1664798). No extra required fields (Opp needs no pipeline_id; Task/Project need no related_resource).
[14:38:00] [Manual Edits + Scratch CLI + Service API] Edit→Push details on all 4 → confirmed in Copper API (4/4 ✅).
[14:40:00] [Scratch CLI + Service API] Delete→Push all 4 → 404 in Copper API (4/4 ✅); unpublished empty. → all 6 Copper entities now have full CRUD via CLI publish.

## 2026-06-15 — add Pipelines + Pipeline Stages (read-only reference) + Opportunity pipeline FKs

Scoped /connector-build-execute pass (pipelines + FK wiring):
[17:05:00] [Research] Cold-read copper-connector/types/api-client/json-schema; mirrored Zoho's read-only-reference pattern (`disabledCreates/Updates/Deletes/Reason` on the TablePreview + special-cased fetch/pull).
[17:08:00] [Manual Edits] Added read-only reference entities `pipelines` + `pipeline_stages` (copper-types.ts), `listReferenceEntities` GET helper (copper-api-client.ts), reference schemas + `buildCopperReferenceTableSpec` (copper-json-schema.ts), and listTables/fetch/pull/pullByIds wiring + read-only write guard (copper-connector.ts). Wired `Opportunities.pipeline_id`→pipelines, `pipeline_stage_id`→pipeline_stages FKs.
[17:12:00] [Scratch CLI] yarn jest copper (33 pass, updated listTables test) + eslint clean.
[17:15:00] [Scratch CLI] linked available coa_v21ua3Q7ct → Pipelines + Pipeline Stages now listed "(creates not supported)". linked add --table-id pipelines / pipeline_stages.
[17:17:00] [Scratch CLI] linked pull dfd_bwojj2rB5a (pipelines) + dfd_Noy32encI1 (pipeline_stages) --mode full → completed.
[17:18:00] [Manual Edits] Confirmed verbatim shape live: Pipelines/sales.json = {id 1149734, name "Sales", stages[5], type "item", is_revenue false}; Pipeline Stages/closing.json = {id 5176286, name "Closing", pipeline_id 1149734, win_probability null}. Added `type`/`is_revenue` columns to the Pipelines schema; re-pulled to regenerate.
[17:21:00] [Scratch CLI] Re-pulled Opportunities (dfd_wL5qMWxhC2) → schema now serializes pipeline_id→pipelines, pipeline_stage_id→pipeline_stages, primary_contact_id→people, company_id→companies (all FK annotations confirmed). Pipeline Stages.pipeline_id read confirmed (5176286→1149734).
[17:23:00] [Research] FK PUSH tests NOT run this pass: test workspace has 0 Opportunities / 0 Tasks / 1 Person (needs seeding), and service-API verification not set up (no decrypt tool; localdev Postgres `scratchpad` not running). Recorded FK push rows as ⬜ pending → scheduled for the 2026-06-16 manual session.
