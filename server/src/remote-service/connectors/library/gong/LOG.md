# Gong connector — activity log

## 2026-08-05 — provisioning + API recon (degraded /connector-build-prepare)

Credential wiring and validation:
[18:10:12] [Service API] Validated the dev-instance API key — curl -u KEY:*** https://us02-125032.api.gong.io/v2/users → 200 (1 user)
[18:12:40] [Manual Edits] Stored CB_GONG_ACCESS_KEY / CB_GONG_ACCESS_KEY_SECRET / CB_GONG_API_BASE_URL in connector-build/.env.connector-build via credential-helpers (no echo)
[18:13:05] [Service API] Re-validated from the stored secrets — GET /v2/workspaces → 200
[18:14:30] [Research] Registered Gong in connector-build/provisioned-connectors.md + .env.connector-build.sample; wrote provisioning-notes

API surface probing (empty instance):
[18:15:22] [Service API] GET /v2/workspaces → 1 workspace "Initial workspace"; GET /v2/settings/scorecards → []; GET /v2/library/folders?workspaceId=… → 4 default folders (parentFolderId self-FK)
[18:16:03] [Service API] GET /v2/calls?fromDateTime=…&toDateTime=… → HTTP 404 + ["No calls found …"] — discovered the empty-result-as-404 quirk
[18:18:41] [Service API] POST /v2/calls (seed attempt) → 400 on a `.example` party email TLD; retried with .com → **409 "Recording or telephony call import is not enabled for primaryUser"** — call seeding is blocked on an admin-UI toggle (users API is read-only; login is Google SSO ⇒ human gate)
[18:19:30] [Service API] Probed alternates: POST /v2/calls with downloadMediaUrl → same 409; POST /v2/meetings → 400 (organizerEmail) — meetings are scheduling stubs, not calls; no API path around the toggle
[18:22:15] [Service API] POST /v2/calls/extensive with the FULL contentSelector (all analysis blocks) → 404-not-400, proving the request shape is valid without any data

## 2026-08-05/06 — build (API-only /connector-build-execute)

Scaffold + schemas:
[18:35:00] [Research] Read CONNECTOR_GUIDE.md end-to-end; studied intercom (fixed-entity reference), youtube (read-only write-method pattern), table-view.ts, notion-default-view displayTransformer pattern
[18:50:00] [Manual Edits] Scaffolded the connector: gong-types.ts, gong-api-client.ts, gong-json-schema.ts, gong-default-view.ts, gong-connector.ts; registered GONG in service-constants.ts + library/index.ts; added gongAccessKey/gongAccessKeySecret/gongBaseUrl to DecryptedCredentials
[19:05:00] [Service API] GET /v2/users → captured verbatim user + folder records as unit-test fixtures (now 2 users — Curtis joined the instance)
[19:20:14] [Scratch CLI] yarn build → green after fixing FK constant name (X_SCRATCH_FOREIGN_KEY_OPTIONS) and updateRecords signature
[19:25:41] [Scratch CLI] cd server && yarn jest src/remote-service/connectors/library/gong → 9/9 unit tests pass (schema conformance vs live-captured records, default-view shape, FK targets)

Logo:
[19:28:02] [Research] Simple Icons has no Gong mark; pulled Gong's current green speech-bubble SVG from gong.io's own site → saved as gong-logo.svg in the connector folder
[19:28:40] [Service API] gcloud storage cp → DENIED (read-only SA, expected) — logo upload left as a one-command human TODO; metadata.logo already points at the canonical URL

Harness + live verification:
[19:30:12] [Scratch CLI] Killed sao-paulo's server on :3010 (one-server rule); started THIS worktree's server (yarn dev) + built release scratchmd
[19:31:05] [Scratch CLI] workspaces create "gong-build" → wkb_TEfntfUZpz
[19:31:32] [Scratch CLI] connections add --service GONG --param gongAccessKey/Secret/BaseUrl → coa_QtMW6OLR7m, Health: OK
[19:32:10] [Scratch CLI] linked available → all 6 tables listed, every one "(creates not supported)"
[19:33:00] [Scratch CLI] linked add users/workspaces/calls/transcripts → 4 dfds; library-folders + scorecards initially 500 "exceeded the service API quota" — the connector had no wired rate limiter
[19:40:00] [Manual Edits] Wired the per-account RateLimiter + Retry-After-aware withRetry around every HTTP call (copper pattern); dev server hot-reloaded
[19:47:20] [Scratch CLI] linked add library-folders + scorecards → OK (dfd_SbYWD9l2AQ, dfd_4r8IGD4lQD)
[19:48:10] [Scratch CLI] linked pull ×6 --mode full → all complete; calls/transcripts/scorecards resolve EMPTY (404-quirk path proven through the real pull pipeline)
[19:49:30] [Scratch CLI] workspaces init wkb_TEfntfUZpz → 7 records on disk with the intended paths: /gong/Users/*.json, /gong/Workspaces/*.json, /gong/Initial workspace/Library Folders/*.json
[19:50:15] [Scratch CLI] validation dry-run enforce_schema on a user, workspace, and folder record → [] (clean) for all three
[19:51:00] [Research] Confirmed views/default.json written for all 6 tables — Calls view: Title/Started/Duration/Direction/Host/Participants + AI Analysis & Interaction banner groups; FK bindings present on folder view

Integration test:
[19:55:00] [Manual Edits] Wrote server/test/integration/gong-connector.spec.ts (read paths + read-only contract + 404-quirk + by-id skip); added GONG_* to server/.env.integration
[19:57:44] [Scratch CLI] yarn test:integration -- gong-connector → **10/10 pass live**

Issues:
[19:29:21] [Research] Filed DEV-11212 (connector launch tracker, Scratch project) and DEV-11213 (Gong in Live Export, [MAJOR] Live Export project, live-export-qa label)

Seed tooling (parked at the human gate):
[19:53:00] [Manual Edits] Wrote test/seed-gong-instance.mjs — 7 torture calls (unicode/emoji, long title, minimal, conference, internal, customData JSON) + optional --with-media (macOS `say` → PUT media) — idempotent via clientUniqueId; fires the moment the admin toggle flips

Live Export audit (/test-live-export GONG SUPABASE,AIRTABLE,NOTION):
[01:38:50] [Scratch CLI] Preflights ×3 green (audit.mjs --no-run); creds keyed by userProvidedParams names added to gong.env
[01:41:00] [Scratch CLI] Run 1 GONG→SUPABASE (wkb_w6ZTG3kWYz) → 7/7 published, 0 failures; FOUND: Parent Folder self-FK dropped (linkedTableId used sanitized wsId — could never match plan candidate tokens)
[01:44:30] [Manual Edits] FIXED DEV-11214: FK tokens → bare remoteId segments via gongForeignKeyLinkedTableId() + linkedTableRemoteId on schema AND view FKs; unit tests pin the form
[01:46:20] [Scratch CLI] Re-run GONG→SUPABASE (wkb_EJ1RkV94NU) → Parent Folder survives the plan
[01:47:10] [Service API] Verified on Supabase (psql): REAL FK constraints ("Parent Folder" REFERENCES self, "Created By" REFERENCES "Users 3"); 3 child folders resolved to Public Folders uuid; values row-exact
[01:47:40] [Scratch CLI] GONG→AIRTABLE (wkb_noqLtx7sY3) → 7/7; GONG→NOTION (wkb_6GNSzqrVyd) → 7/7
[01:48:30] [Service API] Verified on Airtable API (multipleRecordLinks resolved) + Notion API (relations resolved; seconds truncation = destination limit)
[01:49:40] [Service API] Drift check: deleted "Competition" row from Supabase out-of-band → --rerun restored it WITH the FK re-resolved
[01:50:42] [Research] Filed DEV-11214 (Done) as sub-issue of DEV-11213; second-run churn (4/6/7 ops) attributed to generic DEV-10556, not re-filed; wrote LIVE_EXPORT_AUDIT.md

## 2026-08-06 — morning: seeding unblocked, data-stage verification

Ingestion-pipeline forensics (gen-1 calls all discarded):
[07:10:00] [Service UI] Ryder flipped per-user call import (Admin → People → Team members) for both users; verified via settings.telephonyCallsImported
[07:15:00] [Scratch CLI] Ran gen-1 seed (7 calls + 2 short AIFF media) → all accepted, then silently discarded: "not ready yet" → "was not found"; clientUniqueIds burned
[07:25:00] [Service API] Probes: no-media call → UI shows "Call wasn't recorded — too short" (Ryder screenshot); 30s WAV → discarded; channel-free mono → discarded
[07:36:00] [Service API] 11.8-min MP3 probe → READY after ~4 min — MINIMUM LENGTH was the killer; also learned "was not found" is a transient mid-processing state
[07:52:00] [Manual Edits] Wrote test/call-scripts.mjs (6 original fake conversations) + rebuilt seed script: gen-2 ids, MULTIVOICE synthesis (per-line `say` voices, ffmpeg concat → unique MP3s), all calls get media
[07:54:00] [Service API] Seeded 6 gen-2 calls (5-7.5 min audio each) → all uploaded 201; processing took ~40+ min (dev-instance queue)

Verification with real data:
[08:35:00] [Scratch CLI] Pulled Calls (7) + Call Transcripts (7); restarted this worktree's server + shared scratch-git after session recycle killed both
[08:38:00] [Scratch CLI] enforce_schema on ALL 13 real records → [] everywhere; content blocks (brief/topics/keyPoints/outline/highlights) present verbatim; transcripts diarized into 32 monologues (multivoice worked)
[08:40:00] [Scratch CLI] Live Export re-run ×3 (wkb_dMwknjZfZ5 / wkb_jm6nZkxjvD / wkb_deuP0mpTvy) → 21/21 published each, 0 failures
[08:42:00] [Service API] Supabase verify: analysis text landed BUT concat had no separators → switched view flatteners to join_comma / join_space; re-ran; verified "Casper Ledger, Ryder Ziola, …" + prose transcript
[08:45:00] [Service API] Verified Notion: emoji/CJK title intact, briefs, Host relation 1-link per call; Airtable 21/21
[08:47:00] [Research] FOUND + filed DEV-11215 [core]: transcripts callId (idPath+FK) consumed as source-record-id → relation column silently dropped on every destination

Pagination coverage (no 200-call seed — page-size reduction attempted instead):
[09:05:00] [Service API] Probed page-size control: GET /v2/users?limit=1 → full page; POST /v2/calls/extensive limit:2 → all 7 — Gong IGNORES page-size params (HTTP 200 either way), so live multi-page cannot be forced under the fixed 100/page
[09:12:00] [Manual Edits] Wrote gong-api-client.spec.ts (mocked cursor loops: threading, resume, last-page stop, mid-stream empty-404, genuine-404 propagation, by-ids accumulation) + gong-connector-pagination.spec.ts (per-page connectorProgress checkpoint + resume-from-cursor) → 18/18 gong tests pass

Transcript → SRT transformer (Ryder's ask: industry-standard script format):
[11:55:00] [Manual Edits] Added generic `transcript_to_srt` transformer: shared pure core (packages/shared-types/src/transform/apply-transcript-to-srt.ts), client-safe applier arm, server sync arm + registry, picker entry — dot-path options keep it connector-agnostic (one cue per timed sentence, "Speaker N:" labels by first appearance)
[12:00:00] [Manual Edits] Gong Transcripts view: replaced the jsonpath flattener with codec.toCore = transcript_to_srt (speakerId/sentences/text/start/end); logicalType stays 'string'
[12:05:00] [Scratch CLI] 27/27 tests pass (9 new transformer specs incl. server-arm + client-arm parity); yarn build green after adding TranscriptToSrtOptions to the TransformerOptions union
[12:08:00] [Manual Edits] Verified against the REAL haunted-CRM transcript via the built shared module: 107 cues, both speakers labeled, ms-accurate timestamps — end-to-end pull+export verification pending a server restart (running dist is stale)
[12:35:00] [Manual Edits] Added the transcript_to_srt arm to the save-sync zod union (sync-mapping.schema.ts) — the draft save rejected the new type until then ("No matching discriminator")
[12:38:00] [Service API] E2E verified: GONG→SUPABASE export (Call Transcripts 5) landed speaker-labeled SubRip — numbered cues, HH:MM:SS,mmm timestamps, "Speaker N:" prefixes on real transcribed content

## 2026-10-01 — DEV-12085: Calls `Started` exported date-only

[13:10:00] [Research] Customer report (VITL, Gong→Supabase): `Calls.Started` created as Postgres `date`. Traced it: the Calls root's x-scratch-agent-instructions + metaData's x-scratch-readonly trip extractSchemaFields' leaf guard → zero Calls schema fields → plan field `{ path, type: 'unknown' }` with no format → the view's 'date' hint → `{ kind: 'date' }` → `table.date`
[13:40:00] [Manual Edits] Wrote __tests__/gong-live-export.spec.ts first — reproduced `"started" date` in the generated Postgres DDL, then added `logicalType: 'datetime'` to Calls Started + Scheduled (gong-default-view.ts). Same trap fixed for Notion created_time/last_edited_time properties, Affinity list-entry createdAt, Attio timestamp/interaction
[14:00:00] [Scratch CLI] cd server && yarn jest src/remote-service/connectors/library/gong --runInBand → 26/26 incl. the new spec (Started → timestamptz / Airtable dateTime; every Gong date column time-bearing)

## 2026-10-01 — DEV-12085 live re-check (/test-live-export GONG SUPABASE)

[15:01:47] [Scratch CLI] Harness preflight OK against the local server built from the fix branch (Gong + Supabase connections health ok)
[15:02:42] [Scratch CLI] audit.mjs --tables "Users,Library Folders,Calls" --second-run-check → wkb_ANzlLQXjlv / syn_1CfDWsBnMB; first run rrn_diGKz90yYY 14/14 published, 0 failedOperations; second run rrn_yUJMSKfG5V no-op; tables created in new schema gong_export
[15:04:00] [Service API] Supabase information_schema: Calls."Started" = timestamp with time zone (control Library Folders."Updated" = timestamptz); Host = FK → Users.id
[15:04:30] [Service API] Gong GET /v2/calls vs Supabase rows: 7/7 start instants exact (09:00-07:00 → 16:00Z), 7/7 Host links = primaryUserId
[15:05:05] [Service API] Drift: deleted one Calls row out-of-band → rerun rrn_pz31eyzB3s re-created it (1 create, 0 failures) with the real start time

## 2026-10-01 — /test-live-export GONG AIRTABLE,NOTION (DEV-12085 follow-through)

[15:19:58] [Scratch CLI] Preflight OK for both destinations (Airtable base + Notion integration tokens valid)
[15:20:28] [Scratch CLI] GONG→AIRTABLE audit.mjs (Users, Workspaces, Library Folders, Calls, Call Transcripts) → wkb_zZC75jkRSh / syn_zrXcbU4gNG; rrn_xpvk8Vca4N 22/22 published, 0 failedOperations; second run rrn_uviEoAdq89 no-op
[15:21:50] [Service API] Airtable meta API: Calls.Started = dateTime (utc); 7/7 start instants = Gong, 7/7 Host links = primaryUserId; 7/7 transcripts SRT-shaped
[15:22:10] [Service API] Duration 1 s off on 2 calls → traced to Gong itself: /v2/calls (299/358) vs /v2/calls/extensive (300/359); destination matches what the connector pulled (extensive)
[15:22:49] [Service API] Airtable drift: deleted "Probe: long audio" record → rerun rrn_N2oqGvzcpN restored it with the real start time + Host
[15:23:21] [Scratch CLI] GONG→NOTION (wkb_faCDBhDxFr) failed at save: object_not_found — the "Live export testing" integration can see 0 pages; the DEST_PARENT_ID page isn't shared with it (human step)

## 2026-10-01 — /test-live-export GONG NOTION (after sharing the QA page)

[15:41:53] [Scratch CLI] Preflight OK; confirmed via the Notion API that the integration can now open the DEST_PARENT_ID page ("Live Export Testing")
[15:42:01] [Scratch CLI] GONG→NOTION audit.mjs (5 tables) → wkb_2buKZv8Fcd / syn_w9JHD9k9M8; rrn_oQQCn9frM0 22/22 published, 0 failedOperations; second run rrn_rh73sdsRbW no-op
[15:43:40] [Service API] Notion API: Calls.Started = date; 7/7 values keep time + offset (09:00:00.000-07:00) and match Gong; 7/7 Host relations + titles exact; 7/7 transcripts complete (longest 20,275 chars)
[15:44:05] [Service API] Drift: trashed one Calls page → normal run rrn_NgBiCrHlTS "No changes" (incremental destination pull can't see it — by design, DEV-11407) → forceFullPull run rrn_FKK9QlqSZW restored it (new page, correct Started + Host)
