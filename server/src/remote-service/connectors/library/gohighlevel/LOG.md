<!-- Plain-language, append-only journal of every operation actually performed on the
     GoHighLevel connector. One op per line: [hh:mm:ss] [type] description — literal call.
     Tags: [Service UI] / [Service API] / [Scratch CLI] / [Manual Edits]. Mask tokens. -->

# GoHighLevel connector — activity log

## 2026-06-10 — opportunity followers (built-but-untested TODO → verified)

Cleared the followers TODO via CLI publish (opp `VbhtTZuBBsTPrVduE9p5`; harness recovered — the local server had no repo for `coa_yPWo8whEMY`, so re-pulled + made a fresh clone at `local/cli-v4/ghl-fresh/ghl-test`):
[23:25:28] [Service API] Baseline — GET /opportunities/VbhtTZuBBsTPrVduE9p5 → followers ['EtHf…']
[23:28:25] [Manual Edits] opp1 followers ['EtHf…'] → [] — opp1-in-ivans-1st-pipeline-edited.json
[23:28:30] [Scratch CLI] accept + upload + publish (remove) — files accept "…opp1…" && upload && publish → Published 1 connection
[23:28:45] [Service API] PASS — GET opp → followers [] (remove via Scratch; the original 422 is fixed)
[23:28:58] [Manual Edits] opp1 followers [] → ['j1Ge3…' Joel]; published → GHL still [] (didn't add)
[23:30:10] [Service API] Probed directly — POST /opportunities/{id}/followers {followers:['j1Ge3…']} → 201 but followersAdded:[[]] (no-op); EtHf adds fine (followersAdded:[['EtHf…']]). Joel is a valid location ADMIN → GHL silently refuses an ineligible follower (201, nothing added).
[23:31:33] [Scratch CLI] ADD EtHf via publish (after reset GHL→[] + re-pull) → PASS, GHL followers ['EtHf…']
[23:32:02] [Manual Edits] opp1 name → "Opp1 MIXED name+followers test" AND followers → []; accept+upload+publish
[23:32:15] [Service API] PASS — GET opp → name updated AND followers [] (mixed edit: PUT + follower-reconcile both landed)

## 2026-06-09 — deep pass on branch ghl-impr

Setup + account ID:
[13:10:33] [Manual Edits] Decrypted the GHL PIT from coa_Avlneqisk5 (AES-256-GCM, ENCRYPTION_MASTER_KEY) — replicated src/utils/encryption.ts decrypt; got apiKey=pit-… + locationId 57eAggUmMecWhpP8kkis
[13:10:33] [Service API] Found the web-app login email — GET /locations/57eAggUmMecWhpP8kkis → location "WhaleSync", email joel@whalesync.com (added to STATE.md)

Enumeration (the full surface):
[13:10:33] [Service API] Enumerated custom fields — GET /locations/{id}/customFields → ZERO existed; objects → business, opportunity, contact, custom_objects.posts; counts Contacts 6 / Opps 3 / Pipelines 2 / Users 2 / Proposals 0 / Workflows 0
[13:10:33] [Service API] Seeded all 13 custom-field dataTypes — POST /locations/{id}/customFields (201 each). Findings: EMAIL is NOT a valid dataType (422); FLOAT + TIME exist; TIME needs dateTimeValidation; option types take options:[]

Harness + pull-all:
[13:10:33] [Scratch CLI] Created fresh workspace + connection — scratchmd workspaces create "ghl-test" → wkb_v8Sy6Oy7I9; connections add --service GOHIGHLEVEL --param apiKey=pit-… --param locationId=… → coa_m4Gwt30pFK (Health OK)
[13:10:33] [Scratch CLI] Linked + pulled ALL 18 tables — scratchmd linked add/pull each → all "Pull completed" (conversations/blogs included; my direct-API 404/422 were wrong-endpoint guesses, not connector bugs)

Custom-field write round-trip (API evidence; CLI publish GCS-gated):
[13:10:33] [Manual Edits] Wrote 12 custom-field values into Contacts/ivan-dimitrov.json (one per type, skip FILE_UPLOAD)
[13:10:33] [Scratch CLI] files accept OK; **files upload → 500 (GCS reauth gate — gcloud ADC expired)**; publish no-op
[13:10:33] [Service API] Proved the write via PUT /contacts/3MNJodIs74s23TcFT4M8 {customFields:[{id,field_value}]} → 200; GET-back confirms 11/12 land exactly; TIME lossy ("14:30"→"01:30:00")

BLOCKED on two human gates: (1) HighLevel browser login (joel@whalesync.com) for UI seeding/confirmation; (2) gcloud ADC reauth (`gcloud auth application-default login`) for the CLI publish path.

## 2026-06-09 (cont.) — gates cleared → push-✅ via CLI publish

Both gates cleared (HighLevel login testing@whalesync.com + gcloud reauth + server restart):
[14:26:45] [Scratch CLI] Custom-field Edit→Push CONFIRMED — set TEXT field to CLIPUB-141835 in Contacts/ivan-dimitrov.json → files accept/upload/publish → GHL API confirms value landed
[14:26:45] [Scratch CLI] Contacts New→Push CONFIRMED — new contact file → publish → remote id 93nVhfcmkv8YbxBJWSZO flowed back; GET /contacts/{id} confirms (email search lagged — eventually-consistent)
[14:26:45] [Scratch CLI] Contacts Delete→Push CONFIRMED — rm file → publish → GET-by-id 400 (gone)
[14:26:45] [Service API] FK isolation — direct PUT /opportunities/{id} contactId AND pipelineId both 200 + land (GHL allows opp re-parent)
[14:26:45] [Scratch CLI] Opportunity FK CLI-move CONFIRMED — edited ONLY top-level contactId → publish → GHL re-parented (Ivan→ScratchBrowser). ⚠️ Editing the hydrated nested `contact` object too makes GHL ignore contactId → filed as a connector fix (strip hydrated objects on write).
[15:11:04] [Scratch CLI] Opportunities full CRUD via CLI publish — New (id T7a27…)/Edit (name+monetaryValue)/Delete, each confirmed in GHL
[15:11:04] [Scratch CLI] Custom Object (Posts) full CRUD via CLI publish — New (id 6a27…)/Edit (slug)/Delete, confirmed via GET /objects/custom_objects.posts/records/{id}
[15:11:04] [Manual Edits] Applied connector fix — buildOpportunityPayload now strips hydrated read-only sub-objects (contact/notes/tasks/calendarEvents) so contactId FK re-parent is robust — gohighlevel-connector.ts (build+eslint clean; needs server restart to go live)
[15:11:04] [Scratch CLI] Pass-2 edge cases via CLI publish — emoji 🎯/unicode SURVIVE (GHL preserves, vs Zoho strips), 2000-char long string survives, null-clear removes the field. All confirmed in GHL.
[15:11:04] [Scratch CLI] Re-init the live clone to cli-v4/ghl-test for parallel observation (registry → /Users/ijd/repos/spinner/local/cli-v4/ghl-test)
[15:11:04] [Service API] Finding: Forms/Surveys list returns only {id,locationId,name} (no structure); Products/Proposals/Blogs use _id; 6 entities empty (0 records in location)

## 2026-06-09 (cont.) — generic-entity schema fix (Ivan flagged id-only columns)

[15:39:33] [Service API] Confirmed root cause — buildGenericEntityJsonTableSpec only declared the id property, so the desktop table view showed only id for all 13 read-only entities (data was there verbatim via additionalProperties). These entities have NO field-metadata API (ENDPOINTS.md "Schema source": static from OpenAPI).
[15:39:33] [Service API] Extracted static field lists from GHL's published OpenAPI (github GoHighLevel/highlevel-api-docs) for all 13 entities — Calendars 40, Products 17, Users 13, Conversations 11, Calendar Groups 6, Forms/Surveys genuinely 3 (id,name,locationId).
[15:39:33] [Manual Edits] Added GOHIGHLEVEL_ENTITY_FIELDS map (OpenAPI-derived) + GenericFieldType to gohighlevel-entities.ts; buildGenericEntityJsonTableSpec now types the columns from it (read-only, additionalProperties kept); fetchJsonTableSpec passes it. Build + lint clean; verified via dist: calendar_groups→6 cols, products→17, users→13.
[15:57:01] [Scratch CLI] Deleted connection + recreated (per Ivan) to regenerate table specs. Mid-op the local internet dropped → new connection went FAILED + all pulls failed (ECONNREFUSED to GHL/github/google; DNS fine). NOT the code/PIT — transient network. After it recovered: recreated connection coa_QJiXjIC7DU (Health OK), re-linked 18, re-init clone, re-pulled all 18 ✓.
[15:57:01] [Scratch CLI] ✅ Generic-schema fix verified live — regenerated schema.json: Calendar Groups 6 cols (was 1), Calendars 56, Products 17, Users 13, Forms 3. Desktop table view now shows real columns.

## 2026-06-09 (cont.) — seeding + custom-object coverage + docs

[16:15:22] [Service API] Filled empty Companies table — POST /objects/business/records ×4 (Acme/Globex/Initech/Umbrella; short property keys e.g. `name`, not `business.name`) → re-pulled → 4 records in clone.
[16:15:22] [Service API] Confirmed via OpenAPI the other empties have NO create API — Campaigns/Workflows no POST, Proposals only send-endpoints, blogs API creates posts not authors/categories. Marked UI-build-only + seeding UNTESTED in STATE.md.
[16:15:22] [Service API] Created a fresh custom object **Pet** (`custom_objects.scratchpet`, primary field pet_name) via POST /objects/ → connector auto-discovered it (listTables).
[16:15:22] [Scratch CLI] Full CRUD on Pet via CLI publish — New (id 6a28115f…, pet_name=Rex)/Edit(→Rex the Great)/Delete, each confirmed via GET /objects/custom_objects.scratchpet/records/{id}.
[16:15:22] [Manual Edits] Deleted the 146-line ENDPOINTS.md; distilled it into a concise "Endpoints" section in STATE.md. Added the Endpoints-section convention to SKILL.md + coverage-template.md, and a static-vs-dynamic schema-sourcing rule. Updated entities.ts comment ref.
[18:00:32] [Manual Edits] Grouped record paths into type folders — built-in entities → basePath ['Standard Objects'] (buildContacts/Opportunities/Pipelines/GenericEntity JsonTableSpec); human-defined custom objects (custom_objects.*) → ['Custom Objects'], standard business object → ['Standard Objects'] (buildCustomObjectJsonTableSpec, by key prefix). Picker parentPath split too. Build + lint clean.
[18:00:32] [Scratch CLI] Deleted old workspace wkb_v8Sy6Oy7I9; created fresh wkb_nhfjSR3XU5 + connection coa_jmwDAmfxcN; linked + pulled all 19 tables; re-init clone at cli-v4/ghl-test. Verified: /highlevel/Standard Objects/{17 built-ins incl. Companies} + /highlevel/Custom Objects/{Pets, Posts}.
[18:22:29] [Manual Edits] Custom-object fields now declared as typed schema sub-properties of `properties` (buildObjectPropertiesSchema + schemaForObjectFieldDataType + objectFieldShortKey in gohighlevel-json-schema.ts); agent-instructions moved to schema root so `properties` isn't a leaf → client auto-expands one column per field. Build + lint clean.
[18:22:29] [Scratch CLI] Deleted workspace wkb_nhfjSR3XU5; recreated wkb_sVcZ0BPYyU / coa_XEOBxV8izJ; pulled all 19; re-init clone. Verified schema: Posts→properties.slug, Pets→properties.pet_name, Companies→10 named sub-fields, all under properties with additionalProperties:true and no x-scratch on the bag.
[18:35:25] [Manual Edits] Added a defaultView for object tables — buildCustomObjectDefaultView gathers the object's field columns under a "Properties" TableViewBannerGroup (gohighlevel-json-schema.ts), system cols around it. Build + lint clean.
[18:35:25] [Scratch CLI] Deleted workspace wkb_sVcZ0BPYyU; recreated wkb_9VVcgU2sJj / coa_BFEzZWWbDg; pulled all 19; re-init clone. Verified Posts views/default.json: group "Properties" = [slug, content], system cols outside. Desktop now shows the Properties banner.

## 2026-06-09 (cont.) — custom fields → keyed sub-properties (fixes the TIME-collateral bug)

[19:28:15] [Service API] Diagnosed: editing one contact custom field re-sent the whole `customFields` array (arrays diff atomically) incl. the TIME field, whose read-back value GHL rejects on write ("Please enter a valid time", 400). Confirmed GHL merges customFields by id (partial write of one field → 200, others intact).
[19:28:15] [Manual Edits] Reshaped Contacts/Opportunities custom fields array → keyed `custom_fields` object of typed sub-properties (gohighlevel-json-schema.ts + gohighlevel-connector.ts, via a focused sub-agent): pull maps [{id,value|fieldValue}]→{shortKey:value} (id→key from field defs), publish maps back {shortKey:value}→[{id,field_value}]. Added "Custom Properties" defaultView banner-group for contacts/opps; renamed the custom-object group "Properties"→"Custom Properties". Build + lint clean.
[19:28:15] [Scratch CLI] Verified live (fresh wkb_FCfLzF2Syy): contact pulls with keyed custom_fields (no array); edited ONLY scratch_text → publish CLEAN (no time error), GHL shows scratch_text changed + TIME field untouched (23:30:00, still present). Per-field diff confirmed. Views: Contacts "Custom Properties"=[13 fields], Posts "Custom Properties"=[slug, content].

## 2026-06-09 (cont.) — fix: custom-field write RESPONSE was reverting the file to an array

[20:11:19] [Manual Edits] Bug (Ivan): after editing one custom field + publishing, the file reverted to the `customFields` array and all fields showed as edited. Cause: create/update return the GHL response record, which still carries the array — it was pushed un-reshaped, so the persisted record's shape mismatched the keyed pulled shape. Fix: `fetchCustomFieldShortKeyToIdMap`→`fetchCustomFieldKeyMaps` (returns both maps); createRecords/updateRecords now reshape the RETURNED record (`reshapeCustomFieldsArrayToObject`, value/fieldValue) before persisting. Lint clean; watch-mode server reloaded OK (no yarn build — that collides with the running watch on dist/ and kills the server).
[20:11:19] [Scratch CLI] Verified (valid test, absolute scratchmd path): edit scratch_text → publish → "Published", GHL updated (REVERTTEST), file STAYS keyed (no array), `files unpublished` empty, TIME untouched (23:30:00). (An earlier "pass" was a false positive — a relative `$SM` path stopped resolving after `cd` into the workspace, so accept/upload/publish silently never ran. Lesson: use an absolute scratchmd path when cd'ing into the clone.)
[20:19:18] [Manual Edits] View-group fix (Ivan): (1) renamed the field group "Custom Properties"→"Custom Fields" (GHL's term, not an invented one); (2) the objects API flags each field `standard` (business.* = true, custom_objects.* = false) — buildCustomObjectDefaultView now keeps STANDARD fields flat and groups only custom (standard:false) ones, so the Businesses/Companies object's name/phone/email no longer mislabel as custom. Added `standard?` to GoHighLevelObjectField. Lint clean; verified via dist: Companies→flat name/phone (no group), Pets→"Custom Fields"[pet_name].
[23:17:39] [Manual Edits] Read-only fix (Ivan): dateAdded/dateUpdated (+ id, locationId) were editable in the desktop though publish drops them. Cause: the schema marked them `x-scratch-readonly:true`, but buildStandardEntityDefaultView only set the VIEW col `readonly` on `id` — and the grid honors the col's readonly when a defaultView exists. Fix: derive each col's `readonly` from the property's x-scratch-readonly. Verified via dist: id/dateAdded/dateUpdated/locationId → readonly true, email/firstName → false. (buildCustomObjectDefaultView already set readonly on its system cols.) Added a SKILL.md Stage-A rule: label every read-only field x-scratch-readonly (esp. server timestamps) AND propagate it into the default view's columns.

## 2026-06-22 — fix: fresh-pull validation errors (schema stricter than the verbatim API) [DEV-10498]

Schema validation after a fresh pull (should be 0 errors):
[20:30:00] [Research] Ivan reported many validation errors after a fresh pull. Reproduced with `scratchmd validation get-stats`: 16 errors across 7 folders. Classified 4 root causes, all "schema stricter than the verbatim GHL API": (1) optionalString non-nullable, but GHL returns absent optionals as explicit `null` (assignedTo/city/dateOfBirth/postalCode/businessId/lostReasonId/source) → `null is not of type "string"`; (2) generic read-only entity fields emitted as REQUIRED (genericFieldTypeToSchema not Optional) → "required but missing or null" (Users/Conversations/Calendars/Products/Calendar Groups); (3) indexVersion typed string but GHL returns a number; (4) anyOf too narrow — a custom TIME field value 1410 (number) fell to the string-only default, and Users.scopes typed string but is an array `[]`.
[20:40:00] [Manual Edits] Fixed gohighlevel-json-schema.ts + gohighlevel-entities.ts: optionalString/readonlyOptionalString → nullable unions; added readonlyOptionalNumber and used it for indexVersion; genericFieldTypeToSchema wraps every field in Type.Optional; broadened the default custom-field value to a scalar union (string|number|boolean|null); GOHIGHLEVEL_ENTITY_FIELDS users.scopes string→array. Server build + eslint + unit tests clean.
[20:48:00] [Scratch CLI] Verified on a real fresh pull (wkb_q2uBRLh9xK, all 19 tables re-pulled against the watch-mode fixed code + `index refresh-folder --validate`): `validation get-stats` → `[]` (0 errors, was 16). Spot-checked the previously-failing records are present and clean: Contacts(6, scratch_time=1410), Opportunities(3, indexVersion 1/2/null), Users(2, scopes []) — all problems=[].

## 2026-06-22 — make Calendars writable (CRUD) + write-capability sweep

Scope gate + live API research (decrypted PIT for coa_yPWo8whEMY, Location 57eAggUmMecWhpP8kkis):
[22:05:00] [Service API] Probed `calendars.write` scope: `POST /calendars/` `{locationId}` → 422 "name must be a string" (not 401) ⇒ scope present. Then `{locationId,name}` → 201 (created `ZKJNrDlC1UvvhAOfOGg6`) ⇒ only `name` required. `PUT /calendars/{id}` `{name}` → 200 (sparse merge). `DELETE /calendars/{id}` → 200 "calendar deleted". Cleaned up the probe calendar. Responses wrap the object in `{ calendar }`.
[22:08:00] [Service API] Write-capability sweep of all 12 generic entities via stub `POST` — API-writable (422/400): calendar_groups, products, trigger_links, users, conversations(partial). Scope-gated (401): proposals. No write route: campaigns/workflows (404), forms/surveys/blog_authors/blog_categories (401 "not yet supported by IAM"). Recorded as the write-capability matrix in STATE.md.

Implementation:
[22:20:00] [Manual Edits] Added Calendars write codepath. api-client: `createCalendar`/`updateCalendar`/`deleteCalendar` (POST/PUT/DELETE `/calendars/[{id}]`, unwrap `{ calendar }`, inject locationId, 404-tolerant delete). connector: `CALENDARS_TABLE_WS_ID` branches in createRecords/updateRecords/deleteRecords + `buildCalendarPayload` (drops id/locationId; sparse on update). json-schema: `buildGenericEntityJsonTableSpec` now takes a read-only-exception set that flags an entity writable; `genericFieldTypeToSchema` takes a `readonly` bool. Calendars passes `{locationId}` → every field editable except id/locationId. Server build + eslint + unit tests + prettier clean.

CLI-publish CRUD round-trip (wkb_q2uBRLh9xK, calendar WWVsVFyG2Rm6K3bn928W):
[22:30:00] [Manual Edits] Edit→Push: set name="Scratch Edit Calendar", slotDuration=45 in test-calendar-1780588228.json.
[22:31:00] [Scratch CLI] `files accept … && files upload && files publish` → "Published 1 connection(s)".
[22:31:30] [Service API] Confirmed in GHL: GET /calendars/WWVsVFyG2Rm6K3bn928W → name="Scratch Edit Calendar", slotDuration=45.
[22:33:00] [Manual Edits] New→Push: created scratch-new-cal.json `{name:"Scratch New Calendar", slotDuration:20}` → accept/upload/publish → new id `jrfL7mkFJ975N0SwnHDh` flowed back into the file; GHL count 1→2; GET confirmed. (Note: after the first publish the clone needed `files download` to re-sync before the create planned.)
[22:35:00] [Scratch CLI] Delete→Push: `rm scratch-new-cal.json` → accept/upload/publish → GHL GET → 400 (gone), count 2→1.
[22:36:00] [Manual Edits] Fixed `openHours` schema bug surfaced during testing (Ivan asked): GHL returns it as an empty object `{}` when unconfigured (array when set), but it was typed `array` → `validation dry-run` flagged `{} is not valid under 'anyOf'`. Typed it `unknown` in GOHIGHLEVEL_ENTITY_FIELDS; re-pull → dry-run on the calendar record `[]`. (The persisted problems index falsely showed clean — dry-run was the source of truth.)
[22:38:00] [Service API] Restored the test calendar's original name/slotDuration; deleted temp PIT files. Final state: 1 calendar, original name — test location left as found.
