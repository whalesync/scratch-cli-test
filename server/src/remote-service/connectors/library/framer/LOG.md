# Framer — Connector Build Activity Log

Plain-language, append-only journal of operations performed building/testing the Framer connector. One line per operation. Newest day at the bottom.

## 2026-06-18 — research, scaffold, first pull

Research the Framer Server API:
[22:50:00] [Research] Read the Framer Server API announcement + FAQ + intro/quick-start/reference docs — confirmed it's a stateful WebSocket transport via the `framer-api` SDK, no REST surface.
[22:55:00] [Research] Cloned github.com/framer/server-api-examples; read csv-importer / json-api / publish / notion-sync examples — learned connect()/getCollections()/getFields()/getItems()/addItems()/removeItems()/publish()/deploy() surface.
[23:00:00] [Research] Installed framer-api@0.1.16 in /tmp and read its 7882-line index.d.ts — extracted the CMS data model (Collection/ManagedCollection, 15 field types, CollectionItem `{id,slug,draft,fieldData}` keyed by field id with `{type,value,valueByLocale}` entries).
[23:01:00] [Research] Cold-read the connector framework (connector.ts base contract, Airtable + Webflow as dynamic-CMS references, FK machinery in ref-cleaner/file-reference/schema-helpers). Confirmed generic FK discovery follows nested `fieldData.<id>.value` paths → store verbatim.

Set up branch + credentials:
[23:02:00] [Scratch CLI] Branched `framer-connector` off latest master; later rebased onto freshly-merged origin/master.
[23:03:00] [Manual Edits] Added FRAMER_API_KEY / FRAMER_PROJECT_URL to server/.env.integration (+ .example); created STATE.md with the test-account note.

Verify the API key live:
[23:02:00] [Service API] Ran a `framer-api` smoke script with the supplied key → getProjectInfo() = project "Relieved Look"; getCollections() = 2 user collections ("Collection", "Collection 2"); 0 managed collections; confirmed item shape.

Scaffold the connector:
[23:04:00] [Manual Edits] Wrote framer-types.ts, framer-api-client.ts (SDK wrapper), framer-json-schema.ts, framer-default-view.ts, framer-connector.ts (+ registration); added FRAMER to service-constants + library/index; added `projectUrl?` to DecryptedCredentials.
[23:20:00] [Scratch CLI] `yarn build --filter=server` green; `yarn jest framer` → 8/8 unit tests pass; eslint clean.
[23:25:00] [Manual Edits] Fixed ESM-in-CJS boot crash (ERR_REQUIRE_ASYNC_MODULE): load framer-api via a `Function`-guarded dynamic import() instead of a static import; rebuilt; server boots clean.

Stand up the CLI harness + first pull:
[23:36:00] [Scratch CLI] `workspaces create framer` → wkb_amuzIPRjDw.
[23:36:00] [Scratch CLI] `connections add --service FRAMER --param projectUrl=… --param apiKey=…` → coa_tfLoDoeoRa, Health OK (live WebSocket connect through the server).
[23:36:00] [Scratch CLI] `linked available` → both collections listed; linked + pulled both (dfd_A41nz2mzdY Collection 2 = 1 item, dfd_AkjP0Mwz46 Collection = 0 items).
[23:37:00] [Scratch CLI] Cloned workspace to /tmp/framer-ws; verified `Collection 2/adsdas.json` stored verbatim, schema.json + views/default.json generated correctly.
[23:38:00] [Scratch CLI] `validation dry-run --validator enforce_schema` on the pulled record → `[]` (schema sound). Milestone 3 done.

## 2026-06-19 — full CRUD, write translation, edge cases, tests

Seed all field types:
[00:25:00] [Service API] Seeded "Tags" (FK target: design/engineering) + "Field Types" (12 fields, one of each type) via the framer-api SDK — /tmp/framer-types/seed.mjs.
[00:30:00] [Scratch CLI] Linked + pulled Field Types (dfd_kc8OO31OwI) + Tags; cloned; confirmed all field types stored verbatim; `enforce_schema` → `[]` after schema fixes.
[00:32:00] [Manual Edits] Schema fixes: enum value → nullable string (read = case NAME not id); fieldData entry `value` made optional (empty fields omit it). framer-json-schema.ts.

Edit/New/Delete round-trips (CLI publish → confirmed in Framer):
[00:40:00] [Manual Edits] Edited Title on sample-one.json; [Scratch CLI] accept→upload→publish; [Service API] verified "Sample One EDITED" in Framer.
[00:45:00] [Manual Edits] Multi-field edit (number/boolean/link/enum/single-ref/multi-ref) — first attempt FAILED: enum/ref write rejected (`Expected a valid enum case`), whole batch lost, job still reported "Published".
[00:50:00] [Service API] Probed write shapes: enum write needs case ID (read=name); reference write needs item ID (read=slug). /tmp/framer-types/probe-write.mjs.
[01:00:00] [Manual Edits] Implemented enum name→id + reference slug→id write translation (`getWriteTranslationMaps` in client; `translateEnumAndReferenceValuesToIds`/`translateValueToId` in connector).
[01:10:00] [Scratch CLI] Re-ran the multi-field edit incl. enum+refs → published; [Service API] all 6 fields landed (enum "Live", ref re-parented design). FK move (Stage D) confirmed for single + multi reference.
[01:15:00] [Manual Edits] Edited date/color/formattedText(+emoji); [Service API] confirmed — and observed normalization: date→ISO, color→rgb(), formattedText gains dir="auto"; emoji preserved.
[01:20:00] [Manual Edits] Created sample-three.json (New→Push); [Scratch CLI] published; new id `QxjKeIjJf` flowed back into the file.
[01:25:00] [Scratch CLI] Deleted sample-two.json (Delete→Push); [Service API] confirmed only sample-one/sample-three remain. Re-pull → `files unpublished` clean (normalization phantom-diff reconciled).

Tests + fixtures:
[01:35:00] [Manual Edits] Wrote framer-write-translation.spec.ts (12 unit tests) + live integration spec framer-connector.spec.ts + idempotent bootstrap-framer-test-data.mts. 20 unit tests pass.
[01:40:00] [Research] Live integration spec can't run in CJS jest (framer-api ESM+TLA; --experimental-vm-modules breaks nanoid) — documented; rely on CLI validation + unit tests.
[01:45:00] [Research] GCS gcloud ADC expired mid-run (`invalid_rapt`) — blocks `files upload` (CLI publish) and `gcloud storage cp` (logo upload). Not a connector bug. Image-write CLI round-trip + logo upload deferred to post-reauth.

## 2026-06-19 (cont.) — gcloud reauth, deeper tests, adversarial review

Unblocked by gcloud reauth:
[02:30:00] [Manual Edits] Uploaded framer-logo.svg → gs://spv1eu-production-static/connector-icons/framer.svg; curl https://static.scratch.md/connector-icons/framer.svg → 200.
[02:35:00] [Manual Edits] Image write: set Hero to a new external URL + draft=true; [Scratch CLI] published; [Service API] confirmed re-hosted to a fresh framerusercontent.com URL + draft=true.
[02:40:00] [Manual Edits] Field-clear tests: empty-string on Website → landed as ""; null on Count → DROPPED (platform merge-patch), Count stayed 99. Documented.

Adversarial review (codex) + fixes:
[02:25:00] [Research] Ran `codex` adversarial challenge on the connector diff — 12 findings (385k tokens).
[02:50:00] [Manual Edits] Fixed 3 real ones: framer-api-client `withConnection` wraps disconnect() in .catch (no error masking); enum/reference translation maps made deterministic (slug/name wins over id-passthrough on collision); framer-connector createRecords throws on read-back miss instead of returning an id-less record.
[03:00:00] [Scratch CLI] Re-verified post-fix: enum "Draft" + ref "engineering" edit landed; new "codex-check" create → id t4IOvSL_U flowed back; deleted codex-check. 20 unit tests still green.
[03:05:00] [Manual Edits] Flipped metadata.visible → true; updated STATE/LOG/playbook + summary-table Visible → 👁️.

## 2026-06-19 (cont.) — quirks doc + hard bug hunt

Documentation:
[03:30:00] [Manual Edits] Added a 15-point KNOWN QUIRKS catalog (Q1–Q15) to the top of framer-connector.ts so adversarial reviews can skip intentional behavior; reverted visible→false (maintainer sign-off pending).

Bug hunt (SDK probes + CLI):
[03:40:00] [Service API] Probed slug handling: Framer NORMALIZES slugs on create ("Hello World!"→"hello-world"); duplicate slug throws.
[03:45:00] [Manual Edits] BUG FIX: createRecords read-back-by-sent-slug missed on normalized slugs → spurious throw + lost id. Rewrote to id-diff (snapshot ids, create, new ids in input order — verified getItems appends in creation order). Removed now-unused getItemsBySlugs.
[03:50:00] [Scratch CLI] Verified fix live: created with slug "Hello World From CLI!" → Framer stored "hello-world-from-cli", id M0sVyPMjN captured, no throw.
[03:55:00] [Service API] Probed update behavior: MERGE confirmed (partial fieldData preserves other fields — no data loss); empty multi-ref []=clear; ref-to-nonexistent throws; numbers/long-strings/date-with-time all fine; slug-change-on-update normalizes.
[04:00:00] [Manual Edits] BUG FIX: link schema format:'uri' rejected an empty/cleared link ("" fails uri format) → verbatim record failed enforce_schema. Dropped format:'uri'; added regression unit test. Verified live → [].
[04:02:00] [Manual Edits] Hardening: unsupported field values marked x-scratch-readonly. 21 unit tests green.
