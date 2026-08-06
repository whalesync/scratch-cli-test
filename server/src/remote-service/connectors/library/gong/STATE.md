# Gong connector — coverage state

> **DO NOT DELETE.** Generated and maintained by `/connector-build-execute`; this is the connector's resumable coverage state.

## Metadata

- **Template version:** 2026-06-18
- **Last run:** 2026-08-06 (morning: seeded real calls, data-stage verification complete)
- **Type:** STATIC schema · **READ-ONLY connector** (the Gong API has no update surface for any exposed entity — writes are limited to call ingestion + CRM upload, which are integration pipelines, not record edits). All write cells below are `➖` by design, not gaps.

## Test account

- Gong **partner developer instance** (Gong has NO self-serve signup — sales-led; instance requested via the collective.gong.io form 2026-07-30, granted 2026-08-05). Full record: [provisioning-notes.md](./provisioning-notes.md).
- Login: ryder@whalesync.com via **Google SSO only** — no password login exists, so browser automation is impossible; all testing is **API-only** (sufficient for a read-only connector).
- Users in instance: Ryder Ziola + Curtis Fonger. One workspace: "Initial workspace" (`1299375510811165803`).
- Credentials: `CB_GONG_ACCESS_KEY` / `CB_GONG_ACCESS_KEY_SECRET` / `CB_GONG_API_BASE_URL` in `connector-build/.env.connector-build`, mirrored in `server/.env.integration` (`GONG_*`) and Ryder's `~/spinner/local/audit-creds/gong.env`. Never the key itself here.
- Scratch harness: workbook `wkb_TEfntfUZpz` (`gong-build`), connection `coa_QtMW6OLR7m`, local clone `~/scratch-workspaces/gong-build`.

## Objects / entity types

### (a) Structural entities

| Entity | Role | Path treatment | Resulting record path |
| --- | --- | --- | --- |
| Workspace | Gong's top-level data partition (a company can have several) | **path segment** (`basePath = [workspaceName]`) for all workspace-scoped tables; also a Main entity table of its own | `/{connection}/{Workspace}/Calls/{call}.json` etc. |
| Company (the Gong account) | connection scope — always singular per API key | not in path | — |

### (b) Main entities

| Entity | Table | Endpoint | Status | Notes |
| --- | --- | --- | --- | --- |
| Calls (with full AI analysis) | `calls-<wsId>` per workspace | `POST /v2/calls/extensive` | **built** | Record = verbatim extensive shape: `metaData` + `parties`/`content`/`interaction`/`collaboration`/`media`/`context` blocks (blocks appear as Gong's async analysis completes) |
| Call Transcripts | `transcripts-<wsId>` per workspace | `POST /v2/calls/transcript` | **built** | One record per call (`callId` FK); monologues with ms-timed sentences |
| Users | `users` (company-wide) | `GET /v2/users` | **built** | Read-only reference table; `managerId` self-FK |
| Workspaces | `workspaces` (company-wide) | `GET /v2/workspaces` | **built** | Tiny reference table; FK target for calls/scorecards |
| Library Folders | `library-folders-<wsId>` per workspace | `GET /v2/library/folders?workspaceId=` | **built** | `parentFolderId` self-FK, `createdBy` FK→users |
| Scorecards (definitions) | `scorecards-<wsId>` per workspace | `GET /v2/settings/scorecards` (client-side workspace filter) | **built** | Questions embedded verbatim |
| Answered scorecards (reviews) | — | `POST /v2/stats/activity/scorecards` | planned | Stats-style POST filter; a real record stream worth a table later |
| Audit logs | — | `GET /v2/logs` | planned | Needs log-type enumeration; niche |
| Meetings | — | `POST /v2/meetings` (create-only; no list endpoint) | **not-exposed** | No list/read endpoint — nothing to pull |
| CRM objects | — | `/v2/crm/*` | **not-exposed** | Push-only surface for feeding YOUR CRM data INTO Gong; only readable for a generic-CRM integration you registered yourself — not company data |
| Stats / activity aggregates | — | `POST /v2/stats/activity/*`, `/v2/stats/interaction` | **not-exposed** | Aggregate query results over date ranges, not records; no stable identity to sync |
| Engagement events | — | `PUT /v2/customer-engagement/*` | **not-exposed** | Write-only event reporting |
| Permission profiles | — | `GET /v2/permission-profile*` | planned | Admin-config data; low value, revisit on demand |

### (c) Scoped / non-top-level entities

| Entity | Why not top-level | How reached | Status |
| --- | --- | --- | --- |
| Parties (call participants) | Only exist inside a call | embedded verbatim in the call record (`parties[]`) | built |
| Trackers / topics / key points / outcome | Analysis blocks of a call | embedded verbatim in `content` | built |
| Public comments | Scoped to a call | embedded verbatim in `collaboration` | built |
| Transcript monologues/sentences | Scoped to a transcript | embedded verbatim in `transcript[]` | built |
| Library folder contents (calls in folder) | Separate endpoint `GET /v2/library/folder-content` keyed by folder | not fetched in v1 — folder records carry the tree only | planned |

## Milestones

| # | Milestone | Status |
| --- | --- | --- |
| 1 | Account ready | ✅ (dev instance granted 2026-08-05; API-only — no web login possible) |
| 2 | Connected (health OK) | ✅ `coa_QtMW6OLR7m` |
| 3 | First fetch (≥1 record pulled) | ✅ users/workspaces/folders pulled + `enforce_schema` clean |
| 4 | All entities seeded & fetched | ✅ calls (7) + transcripts (7) seeded via ingestion API + multivoice TTS media, pulled + verified; scorecards still empty (admin-UI-only creation — UNTESTED with data, shape verified empty) |
| 5 | Full write CRUD | ➖ read-only by design — writes throw + tables flagged `disabledCreates/Updates/Deletes` |
| 6 | Foreign keys tested | ✅ read direction: folder self-FK + createdBy + calls→Host(users) verified END-TO-END on 3 Live Export destinations (real Postgres constraints, Airtable links, Notion relations); transcripts→calls FK blocked by generic DEV-11215 (idPath+FK collision in the plan generator); write direction ➖ |
| 7 | Edge cases & quirks tested | ✅ empty-as-404, async ingestion lifecycle, media dedup/minimum-length, unicode/CJK/emoji titles, long title, minimal record, 4-party conference, both hosts — all pulled + schema-clean |
| 8 | View(s) built | ✅ all six tables; calls view has structural banner groups (AI Analysis / Interaction) + JSONPath flatteners; Transcript column renders **speaker-labeled SubRip (SRT)** via the new generic `transcript_to_srt` transformer (codec.toCore drives grid + Live Export; verified on the real haunted-CRM transcript → 107 cues, 2 speakers) |
| 9 | OAuth | ➖ **decided: not adopting** (Ryder, 2026-08-06). API keys are equivalent in practice — both paths require a Gong admin, and OAuth is only mandatory for a published Gong Collective marketplace app, adding token-refresh plumbing + Gong app review for no capability gain. Requirements stay documented here in case a marketplace listing is ever wanted: authorize at `https://app.gong.io/oauth2/authorize`, per-endpoint scopes, app registered via the Collective. |
| 10 | Integration test | ✅ `server/test/integration/gong-connector.spec.ts` — 10/10 pass live (2026-08-06). CI wiring (masked var + 06-environment-tests.yml) pending — follow-up, not a gate. |

### TODOs

- [x] ~~Enable call import~~ — DONE 2026-08-06 (Admin → People → Team members → per-user data capture; both users enabled); seeded via `test/seed-gong-instance.mjs` (gen 2, multivoice MP3s from `test/call-scripts.mjs`).
- [ ] **[HUMAN] Upload the logo**: `gcloud storage cp server/src/remote-service/connectors/library/gong/gong-logo.svg gs://spv1eu-production-static/connector-icons/gong.svg --content-type="image/svg+xml"` (read-only SA can't write the bucket; metadata already points at the URL). Verify 200.
- [x] ~~After seeding~~ — DONE 2026-08-06: 6+1 calls + 7 transcripts pulled, `enforce_schema` `[]` on every real record; content blocks (brief/topics/keyPoints/outline/highlights) verified verbatim; `callOutcome` was null on all TTS calls (revisit if real outcomes appear); flatteners switched to `join_comma`/`join_space` after live check. Call→Host FK verified on 3 destinations; transcript→call FK blocked by DEV-11215 (generic).
- [ ] Seed scorecards + answered scorecards (admin UI only — needs a human Gong session) and verify that table with data.
- [ ] Add `GONG_*` masked CI variables + wire the spec into `gitlab-ci/stages/06-environment-tests.yml`.
- [x] ~~Pagination test~~ — DONE 2026-08-06 via mocked cursor tests (Gong ignores page-size params, so live multi-page needs >100 records — deliberately not seeded; see Bulk limits section).
- [ ] Consider `remoteWebUrl` for tables (needs the app-cell URL, e.g. `https://us02-125032.app.gong.io/…`; deriving it from the API base URL is a guess — omitted rather than risk a broken link).
- [ ] Answered scorecards + audit logs as future tables (see Objects (b)).

## Coverage matrix (entities × operations)

Write columns are `➖` **by design** (read-only API). Legend: ✅ verified live · ⬜ not yet · ➖ N/A · ❌ broken.

| Entity | Pull | Pull-by-id | Create→Pull (seed via API) | Edit→Push | New→Push | Delete→Push | Schema valid (`enforce_schema`) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Users | ✅ (2 records) | ✅ (+404-skip ✅) | ➖ (users API read-only; teammates join via Gong) | ➖ | ➖ | ➖ | ✅ |
| Workspaces | ✅ (1) | ✅ (list-filter) | ➖ | ➖ | ➖ | ➖ | ✅ |
| Library Folders | ✅ (4 defaults) | ✅ (list-filter) | ⬜ (no API create; UI-only — blocked, API-only run) | ➖ | ➖ | ➖ | ✅ |
| Calls | ✅ (7 records incl. all analysis blocks) | ✅ (via workbook re-pull) | ✅ seed script (gen 2, multivoice MP3) | ➖ | ➖ | ➖ | ✅ `[]` on all 7 real records |
| Call Transcripts | ✅ (7 records, 32-monologue diarization) | ✅ | ✅ (media → async transcription) | ➖ | ➖ | ➖ | ✅ `[]` on all 7 |
| Scorecards | ✅ empty path; ⬜ with records | ⬜ | ⬜ (no API create; admin UI only) | ➖ | ➖ | ➖ | ⬜ |

## Foreign keys / associations

Write direction is `➖` everywhere (read-only). `linkedTableRemoteId` emitted on every FK for Live Export folder binding.

| FK (field → target) | Read | Write via CLI |
| --- | --- | --- |
| calls `metaData.primaryUserId` → users | ✅ (resolved on Supabase uuid FK, Airtable link, Notion relation) | ➖ |
| calls `metaData.workspaceId` → workspaces | ✅ pulls verbatim (hidden col; not exported by default) | ➖ |
| transcripts `callId` → calls (same workspace) | ✅ value pulls verbatim; ❌ Live Export relation column blocked by **DEV-11215** (idPath+FK collision — generic plan-generator gap; linkage survives via `gong_record_id`) |  ➖ |
| users `managerId` → users (self) | ✅ null values pull clean; non-null pending a manager assignment in the instance | ➖ |
| library-folders `parentFolderId` → library-folders (self) | ✅ (3 child folders point at "Public Folders"; resolved on Supabase/Airtable/Notion via Live Export — DEV-11214 fixed the token) | ➖ |
| library-folders `createdBy` → users | ✅ null values pull clean | ➖ |
| scorecards `workspaceId` → workspaces · `updaterUserId` → users | ⬜ (no scorecards yet — needs admin UI) | ➖ |

## Bulk operation limits / pagination

| Operation | Limit | Mechanism |
| --- | --- | --- |
| Read (all list endpoints) | 100 records/page | opaque cursor in the `records` envelope (`records.cursor` present ⇒ more pages); GET endpoints take `?cursor=`, POST endpoints take a top-level `cursor` body field |
| Create/update/delete | ➖ | no write surface |

- **Page size is NOT controllable** (verified live 2026-08-06): Gong silently ignores every page-size parameter — `GET /v2/users?limit=1` returns the full page; `POST /v2/calls/extensive` with `limit: 2` returns all records, HTTP 200 either way. The cursor only appears past 100 records, so live multi-page behavior cannot be forced on a small dataset. Coverage instead: the client's cursor loops (threading, resume-from-checkpoint, last-page termination, mid-stream empty-404) and the connector's per-page `connectorProgress` checkpointing are pinned by mocked tests (`__tests__/gong-api-client.spec.ts`, `__tests__/gong-connector-pagination.spec.ts`).
- **Org-wide rate limits** (separate from page caps): **3 requests/second** and **10,000 requests/day** per company; 429 + `Retry-After` beyond. Connector registers `rateLimiterSpec {points: 3, duration: 1}` and the API client wraps every call in a `Retry-After`-aware retry.
- **Batch-breaking fields:** none (no writes).

## Incremental polling

**Not supported in v1.** Gong has no modified-since filter on any list endpoint. Calls can be filtered by `fromDateTime`/`toDateTime`, but that keys on the **call time**, not modification time — analysis blocks (brief, trackers) arrive/refresh minutes-to-hours after the call, so a call-time watermark would freeze records whose analysis landed later. Deletions: full pull reconciliation only. Future option: call-time watermark minus a generous re-analysis window (e.g. re-pull the trailing 7 days) as a pseudo-incremental; not built.

## Endpoints

**API version & client:** Gong REST **v2** (`/v2/…`) — the only public version; current as of 2026-08. **Hand-rolled axios client** (`gong-api-client.ts`, house default); no official JS SDK exists (community wrappers only — not adopted deliberately). Base URL is **instance-specific** (`https://us02-125032.api.gong.io`; generic `https://api.gong.io` also resolves). Auth: HTTP Basic (access key / secret). Verdict: **up to date**.

| Entity | Op | Method + path | Note |
| --- | --- | --- | --- |
| (auth check) | test | `GET /v2/workspaces` | cheapest authenticated read |
| Workspaces | list | `GET /v2/workspaces` | no pagination |
| Users | list | `GET /v2/users` | `?limit=100&cursor=` |
| Users | get | `GET /v2/users/{id}` | 404 → skip |
| Calls | list | `POST /v2/calls/extensive` | body: `{cursor?, filter:{workspaceId | callIds}, contentSelector}` — all analysis blocks exposed |
| Transcripts | list | `POST /v2/calls/transcript` | body: `{cursor?, filter:{workspaceId | callIds}}` |
| Library Folders | list | `GET /v2/library/folders?workspaceId=` | `workspaceId` required (400 without) |
| Scorecards | list | `GET /v2/settings/scorecards` | company-wide; filter by record `workspaceId` client-side |
| (seeding only) | create call | `POST /v2/calls` · `PUT /v2/calls/{id}/media` | test fixture generator, not a connector path; gated on the admin call-import toggle |

## Edge cases

- **Empty result = HTTP 404 + errors array** (`["No calls found corresponding to the provided filters"]`), NOT an empty list — on `/v2/calls`, `/v2/calls/extensive`, `/v2/calls/transcript`, even `/v2/users` filters. `isGongEmptyResultError` maps it to empty. Verified through the full pull pipeline (calls/transcripts/scorecards pulled as empty tables, no error).
- **Request-body validation trick:** an invalid body 400s, a valid body over an empty instance 404s — so a 404-not-400 response validates a request shape without any data. Used to prove the full `contentSelector` before any call existed.
- **Emails are validated by TLD** — party `emailAddress` with a `.example` TLD is rejected (400); use `.com` fixtures.
- **Call analysis is asynchronous** — `content`/`interaction` blocks are absent until Gong processes media; schema keeps every block optional so records validate at every stage.
- **`customData`** is a free-form string (often JSON-in-a-string from the ingesting system) — stored verbatim, no parsing.
- **Call ingestion lifecycle (all verified live):** `POST /v2/calls` returns a callId instantly but the call is API-INVISIBLE until its media finishes processing. States: `is not ready yet` → (transiently!) `was not found` → ready. **Media-less calls NEVER become API-visible** (web UI shows them with "Call wasn't recorded"). Recordings under Gong's minimum length (~30s fails; ~12min passes; exact threshold untested between) are discarded — UI says "Looks like the call was too short". Media is **deduped by content hash** (identical audio on a second call → 400). `clientUniqueId` is burned forever even for discarded calls. Six queued transcriptions took ~40+ min on the dev instance (single call took ~4 min).
- **List/count consistency lag:** `records.totalRecords` can count a call the same response's page (and get-by-id) doesn't yet return, while it's in a re-analysis flap.
- **Gong invents parties from audio channels** — "Phone Caller #1/#2" party entries appear alongside the declared parties; stored verbatim.
- **Numeric ids exceed 2^53** (e.g. `6434845837860324905`) but arrive as **strings** — safe; never parse them to numbers.

## Gotchas

- **FK `linkedTableId` must be the bare remoteId segment, never the sanitized wsId** — the create-plan generator matches candidate tokens of the target's `DataFolder.tableId` (DEV-11214, same class as Attio's DEV-11052). `gongForeignKeyLinkedTableId()` owns the token; the exact workspace-scoped target rides in `linkedTableRemoteId`. With multiple Gong workspaces in one plan the bare token alone is ambiguous — the remote-id array disambiguates for consumers that bind by array equality.
- The CLI's `--table-id` flag is **repeatable, one flag per remoteId segment**: `--table-id calls --table-id <workspaceId>`. A single comma-joined value reaches the connector as one segment and fails parsing.
- Without the shared rate limiter, back-to-back `fetchJsonTableSpec` calls (each resolving workspace names) tripped Gong's 3/s limit during `linked add`. The per-account limiter + `resolveWorkspace`'s single listWorkspaces call per spec keep it under; if table-spec fetches ever batch heavily, memoize `listWorkspaces`.

## UI quick-links

(API-only account — links for whoever has the Google SSO session.)

- Web app: `https://us02-125032.app.gong.io/`
- Admin → API keys: `https://us02-125032.app.gong.io/company/api` (Company settings → Ecosystem → API)
- Admin → user data-capture settings (the call-import toggle): Company settings → People → (user) → Data capture
- API docs (session-gated): `https://us02-125032.app.gong.io/settings/api/documentation`
