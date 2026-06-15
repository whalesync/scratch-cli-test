# Affinity connector — implemented plans (archive)

Plan items that have **shipped**, moved here out of [PLAN.md](./PLAN.md) so PLAN stays short.
Write-mostly history — not read in the normal loop; open it only to revisit how a past change was
made. Coverage lives in [STATE.md](./STATE.md), the step-by-step in [LOG.md](./LOG.md).

---

## Publishing phase 1 — v2-native writes · shipped 2026-06-11 (DEV-10298)

Took the connector from read-only to read-write on everything the Affinity v2 API supports natively.

- `updateRecords` pushes changed field values through the v2 `update-fields` batch endpoints for
  persons, companies, and list entries; new `affinity-write-translation.ts` narrows each stored
  read-shape into the write payload the API accepts (dropdowns → `{dropdownOptionId}`, person/company
  refs → `{id}`, locations → the 5 accepted keys) and refuses truncated multi-value reads.
- Notes get full create / edit / delete (`createRecords`/`deleteRecords` are notes-only).
- Unwritable paths (record basics, opportunities, entity files, computed fields) throw a clear error
  rather than silently dropping the edit.
- 38 unit tests; live-verified against the service API + UI for all 11 writable valueTypes and Notes
  CRUD, plus negative tests and a UI round-trip both directions.

Follow-on (still open): Phase 2 (v1-only record create/delete, basics, list membership) — [PLAN.md](./PLAN.md) P2.

## Publishing phase 2 — v1-only writes · shipped 2026-06-12 (DEV-10298)

Completed read-write across the v2 gaps using the v1 API (same Bearer token — no new auth).

- **v1 record lifecycle**: create / update / delete for **persons** (`/persons`), **companies**
  (`/organizations`), **opportunities** (`/opportunities`, create needs an opportunity-type
  `list_id`), plus **list membership** (`POST/DELETE /lists/{id}/list-entries {entity_id}`). New v1
  client methods + a 404-as-no-op delete helper.
- **Writable basics**: firstName/lastName/emailAddresses (person), name/domain (company), name
  (opportunity) — routed to v1 `PUT`; derived siblings (primaryEmailAddress, domains, isGlobal, type,
  id, listId) stay read-only. `updateRecords` splits a change into basics→v1 and field-values→v2.
- **The architecture win**: field VALUES still go through the v2 path even on a freshly v1-created
  record, so the connector never touches the v1 field-values endpoint or its one-row-per-element
  multi-value model. (That multi-value problem is why we route values through v2 — see the original
  P2 plan in git history.)
- 241 unit tests; a connector-driven live integration spec
  (`test/integration/affinity-connector.spec.ts`); and — after a GCS reauth + the
  `20260611120000_workbook_add_settings` migration — **all ops CLI-verified end-to-end**
  (`accept→upload→publish`, confirmed in the service API): New→Push person/company/opportunity/list
  membership, Edit→Push basics, Delete→Push all four. Full write CRUD (Milestone 5) ✅.
- Edge case found & logged: Affinity **title-cases person names on create** (`ZZZ-CLI-P2` →
  `Zzz-cli-p2`), so a create doesn't round-trip byte-exact (phantom-patch family).

## Read-only field labeling audit · shipped 2026-06-11

Marked every non-writable field `x-scratch-readonly` so publish never attempts an edit it can't
deliver: enriched / relationship-intelligence / interaction / formula-number field values, record
basics (firstName/name/domain/emails), note previews + includes, entity-file metadata. The default
view now propagates `readonly` onto dynamic field columns and location banner-group columns (the grid
honors the column's own `readonly`, not just the schema flag).

## Entity-Files foreign keys · shipped 2026-06-11 (Milestone 6, partial)

Declared `x-scratch-foreign-key` on the connector's only clean FK surface — Entity-Files'
`person_id`/`organization_id`/`opportunity_id` (bare scalar ids) → People/Companies/Opportunities.
Read-verified live: the pulled schema carries the annotation and the file's `person_id` resolves to a
real People record in both the local table and the service API. Read-only entity, so the move-parent
write test is N/A. The CRM person/company reference FKs need reshaping first — [PLAN.md](./PLAN.md) P3.

## Incremental polling investigation · resolved 2026-06-11 — not feasible (DEV-10159)

Live-tested every entity with a future-dated modified-since filter (must return 0 rows if honored).
Persons (18→18), companies (39→39), list-entries, and v1 `min_last_modified` all silently ignore it
and return the full set; list-entries carry no row-level modified timestamp at all. Only Notes honors
`filter=updatedAt>=…`, but `updatedAt` is null on never-edited notes (8/10), so a watermark would drop
never-edited records. Verdict: keep full-pull; DEV-10159 correctly canceled. Evidence table in
[STATE.md → Incremental polling](./STATE.md#incremental-polling). No code change.
