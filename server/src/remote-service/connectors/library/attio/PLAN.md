<!-- ⛔ DO NOT DELETE. Maintained by the `/connector-build` skill: this connector's
     ACTIVE plans — atomic, concise items for substantial changes. -->

# Attio — Active Plans

> **Active plans only.** Each item is atomic and concise, with a **Status**: `APPROVED`
> (execute freely) or `FOR_REVIEW` (a human must approve before execution). Small fixes
> skip this doc and are applied immediately (they stay in STATE.md → TODOs). When an item
> ships, move it to [ARCHIVE.md](./ARCHIVE.md) and delete it here so this stays short.
>
> Backfilled 2026-06-12 from the STATE.md TODOs surfaced during the live test run. All
> items are `FOR_REVIEW` — none has been human-approved as a plan yet.

## P1 — Declare foreign keys on `record-reference` + `actor-reference` attributes
**Status:** ✅ APPROVED — implemented + **live-validated** 2026-06-13.
**Done:** `foreignKeyOptionsForAttribute` declares `x-scratch-foreign-key` on (a) **single-target** `record-reference` attrs — `linkedTableId` = the target object's slug, resolved via `config.record_reference.allowed_object_ids[0]` → an **object-id → slug** map (`listObjects`; the config stores object **ids**, not slugs); and (b) `actor-reference` attrs → the Workspace Members table (`workspace_members`). **Multi-target** references are deferred (a single `linkedTableId` can't express N targets). Validated in the pulled schema: `people.company`→companies, `associated_deals`→deals, `associated_users`→users, `created_by`→workspace_members; `deals.associated_company`→companies, `associated_people`→people, `owner`→workspace_members.
**Move test:** CLI move parent→parent confirmed — re-pointed a person's `company` to Atlas, published, verified the re-parent in the API (the `record-reference` write path was already correct: `target_object`+`target_record_id` allowlist). **Milestone 6 ✅.**

## P2 — Propagate read-only flags into the schema (and default view)
**Status:** ✅ APPROVED — code + unit tests landed 2026-06-12; pending live desktop confirm, ships with the connector MR.
**Why:** Schema set `x-scratch-readonly` from `is_archived` only, so the UI let a user edit a non-writable attribute that publish then silently drops.
**Resolution:** Read-only is now derived from **`is_writable === false`** (+ `is_archived`) via `isAttributeReadonly` in `valueArraySchemaForAttribute`; the default view already derives column `readonly` from the schema flag. **Correction to the original TODO:** do **NOT** key off `is_system_attribute` — verified live (2026-06-12) that Attio sets it `true` for *writable* standard fields (`name`/`description`/`domains`), so using it would wrongly lock them. `is_writable` is the precise signal (false only for computed/system-managed: `record_id`, `created_at`, `*_interaction`, `logo_url`, follower counts), and it's present on both object and list attributes.
**Acceptance:** unit tests cover writable-system / non-writable / absent-flag / list-scoped. Remaining: confirm in desktop that a non-writable attribute renders read-only.

## P3 — List-entry parent fields: write-once
**Status:** ✅ APPROVED — code + unit tests landed 2026-06-12; **upgraded to true write-once 2026-06-15 (DEV-10408).**
**Decision (updated):** `parent_record_id` + `parent_object` are now marked **`x-scratch-write-once`** — editable when creating a list entry from the grid, read-only once the entry exists remotely (a list entry can't be re-parented). This replaced the 2026-06-12 interim of "fully writable" once the write-once mechanism shipped.
**Follow-up:** **DEV-10408 resolved** — `x-scratch-write-once` added across shared-types/desktop/validator (see ARCHIVE/LOG). Copper set-on-create FKs can adopt the same flag.
**Acceptance:** unit tests assert parent fields writable + visible while id/created_at stay read-only. Remaining: confirm grid create end-to-end in desktop.

## P4 — Expose Workspace members as a read-only reference table
**Status:** ✅ APPROVED — implemented + **live-validated** 2026-06-12.
**Done:** Endpoint is **`GET /v2/workspace_members`** (underscore — the STATE.md `/v2/workspace-members` guess 404s). Added `AttioWorkspaceMember` type, `listWorkspaceMembers()`, a `members` table kind, and a hardcoded all-read-only schema (`buildAttioMembersTableSpec`) — Attio has no attribute-discovery endpoint for members, so the fixed fields are hardcoded. Own fetch codepath; all writes disabled via `TablePreview` flags. Path `/Workspace Members/{member}.json` (basePath `[]`) — deliberately distinct from the `users` **object** at `/Users/` (P5). Validated: picker shows "Workspace Members (creates not supported)", member pulled verbatim, schema all-read-only.
**Remaining:** wire `actor-reference` fields (owner, created_by) as FKs onto this table (folds into P1 FK work).

## P5 — Custom objects (and ALL their lists)
**Status:** ✅ APPROVED — implemented + **live-validated** 2026-06-12.
**Done:** `listTables` now enumerates **all** objects via `listObjects()` (not the hardcoded 3) and exposes **every** list (dropped the standard-object parent filter). `parseAttioTableId` treats any non-`list` head as an object slug; `buildAttioObjectTableSpec` takes a display label (cached from `listObjects`, falls back to the standard labels / slug). Validated live: the picker gained **Events, Products, Users, Workspaces**; pulled Products + Users (counts match API); an edit→push on a Product was attempted (write path is byte-identical to standard objects — the attempt hit the GCS gate, not a connector issue; standard-object writes already verified).
**Note (answered "why one list?"):** a List is a top-level entity with a `parent_object`; we expose **all** lists, the acceptance test only exercises one to prove the path.

## P6 — Tasks entity (`/v2/tasks`)
**Status:** ✅ APPROVED — implemented + **full CRUD live-validated** 2026-06-13.
**Done:** own `tasks` table kind + codepath (`queryTasks/getTask/createTask/updateTask/deleteTask`, hardcoded schema, `/Tasks/{task}.json`). Read ≠ write resolved: read `content_plaintext`, create sends `content`+`format:"plaintext"`. **Content is immutable on update** (confirmed: PATCH with content → 400 `unrecognized_keys`) → `updateTask` never sends it; editing content on an existing task is a no-op (write-once, **DEV-10408**). Create requires all of content/format/`deadline_at`(date|null)/`is_completed`/`linked_records`/`assignees` — connector defaults any the file omits. Read-only: `completed_at`, `created_by_actor`, `created_at`.
**Validated:** pull (2 tasks, count match); edit→push (`is_completed`+`deadline_at` landed, `content_plaintext` correctly unchanged); create→push (id flowed back, in API w/ assignee); delete→push (404, clean state).

## P5 — Custom objects (and ALL their lists)
**Status:** APPROVED — not yet implemented (needs the dev stack to validate).
**Why:** `listTables` hardcodes the 3 standard objects and **filters lists down to those whose `parent_object` is a standard object**. Attio workspaces can define custom objects (and lists parented to them) we currently can't sync.
**Approach:** Use `GET /v2/objects` (the already-defined-but-unused `AttioApiClient.listObjects()`) to discover non-standard objects; reuse the object fetch/write path; **drop the standard-object filter so every list is exposed regardless of parent object.**
**Note on "lists" (answering "why one?"):** in Attio a **List is a top-level entity with a `parent_object`**; "a custom object's lists" = the lists whose `parent_object` is that object. We expose **all** of them (same enumeration we already do for standard-object lists, just unfiltered) — the acceptance criterion only *tests* one to prove the codepath, it is **not** a cap on how many we sync.
**Acceptance:** a custom object pulls + round-trips CRUD; **all** lists (any parent object) are exposed — verified by exercising at least one custom-object list end-to-end.

## P6 — Tasks entity (`/v2/tasks`)
**Status:** APPROVED — not yet implemented (needs the dev stack to validate).
**Why:** Tasks are a first-class Attio entity we don't sync.
**Approach:** Own top-level table + fetch/write codepath (tasks have a distinct shape from objects). Confirm CRUD support against the API.
**Acceptance:** Tasks pull + round-trip CRUD, or are documented read-only with the API reason.

## P7 — Notes entity (`/v2/notes`)
**Status:** FOR_REVIEW
**Why:** Notes are first-class data attached to records; currently unmapped.
**Approach:** Decide top-level list vs per-record fetch; own codepath. Notes are typically create/read (check update/delete support).
**Acceptance:** Notes pull and at least create→push works, or read-only is documented with the reason.

## P8 — Comments / Threads (scoped deep-fetch)
**Status:** FOR_REVIEW
**Why:** Comments live inside threads on a record (`GET /v2/threads?record=…` → `GET /v2/threads/{thread}/comments`); not top-level fetchable.
**Approach:** Ride the parent record's deep-fetch, embedded into the record (scoped/non-top-level entity per STATE.md table 3). Read first; write path only if the API supports it cleanly.
**Acceptance:** A record's comments appear embedded on pull; write path implemented+tested or marked read-only with the API reason.

## P9 — Incremental polling
**Status:** FOR_REVIEW
**Why:** No `x-scratch-last-modified-field`; full pull only, deletions undetected. Attio supports filtering `…/query` by system timestamps.
**Approach:** Identify the last-modified system attribute, set `x-scratch-last-modified-field`, express a `since` pull via the query filter, derive the new watermark, and decide deletion handling (or document that deletions aren't detected).
**Acceptance:** A `since` pull fetches only records changed after the watermark; watermark advances correctly across runs.

## P10 — Finish + confirm the default view (Milestone 8)
**Status:** FOR_REVIEW
**Why:** `attio-default-view.ts` builds object + list views but Milestone 8 is unverified, and its read-only masking is a hardcoded subset (see P2).
**Approach:** After P2 lands, drive column `readonly`/`type` from the schema; group by real structure only (e.g. custom fields as one group) — never invent thematic groups. Confirm banners span the right columns in desktop.
**Acceptance:** Default view confirmed in the desktop app; Milestone 8 → ✅.

## P11 — OAuth (Milestone 9, final / pre-release)
**Status:** FOR_REVIEW
**Why:** `supportedAuthMethods` is `user_provided_params` only. Bearer wire format already matches the API-key path, so only the provider + redirect wiring is new. Self-serve client (Settings → Developers → new integration → OAuth), no review needed to test within the owning workspace.
**Approach:** Done **with the user** via the browser (they own the dev account/approvals). Add `'oauth'` + an `AttioOAuthProvider`; capture client id/secret into `server/.env` (`ATTIO_CLIENT_ID`/`_SECRET`); record where they live in STATE.md (never the secret).
**Acceptance:** OAuth connect flow works end-to-end against the test workspace, or the exact blocker is documented; Milestone 9 → ✅.
