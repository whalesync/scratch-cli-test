<!-- ⛔ DO NOT DELETE THIS FILE. It is generated and maintained by the `/connector-build-execute`
     skill as the resumable record of this connector's test coverage. The connector
     work itself may need it to extend/finish the connector. Update it in place. -->

# Google Sheets — Connector Test Coverage

> **Do not delete this file.** The resumable record of what's been built and tested. Future work to extend the connector relies on it.

## Test account (used to run this coverage)

- **Service:** ryder@whalesync.com Google account via the shared Whalesync OAuth app. Local dev connection `coa_S8WUAP6AI4` (workbook `wkb_8SJ5l4rHfk`, scratchpaper DB); the refresh token extracted from it lives in `server/.env.integration` alongside a dedicated "Scratch Integration Tests" spreadsheet the API created (`1XIXzKls-p5hwhgaGsJ9o2OBijdjwOS-AR8hZZgzetjo`).
- **Auth method:** `oauth` only (Google authorization-code + refresh token; provider `server/src/oauth/providers/google-sheets-oauth.provider.ts`). **Scope is exactly `https://www.googleapis.com/auth/spreadsheets`** — matching the Whalesync app verbatim; no Drive scope of any kind. Consequences: no listing/browsing of the user's spreadsheets (URL-paste discovery instead), no file deletion, but `spreadsheets.create` IS allowed (Live Export can create fresh spreadsheets).
- **Provenance:** design + implementation by Claude 2026-08-04 from Ryder's brief; design record in `.context/google-sheets-connector-design.md` (Conductor workspace `sao-paulo`).

## Metadata

- **Type:** DYNAMIC (tables = sheet tabs; fields = slugified row-1 headers)
- **Last run:** 2026-08-04 · LIVE integration suite 10/10 passing against the real Sheets API (connect, URL-search, createTable, schema, CRUD, backfill, poison+recovery). 60 unit tests.

Legend: ✅ verified · 🔄 built, not live-verified · ⬜ not yet · ➖ N/A · ❌ broken.

## Milestones — where this connector is in the build

| #   | Milestone                                            | Status | Notes                                                                                                                                                                                                                                                                              |
| --- | ---------------------------------------------------- | :----: | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Account ready**                                    |   ✅   | 2026-08-04: Ryder completed the OAuth flow (after the `iapp_sheets` redirect fix); refresh token extracted into `.env.integration`                                                                                                                                                 |
| 2   | **Connected** (connection created, health OK)        |   ✅   | `coa_S8WUAP6AI4` in workbook `wkb_8SJ5l4rHfk` (local dev)                                                                                                                                                                                                                          |
| 3   | **First fetch** (≥1 record pulled, schema validated) |   ✅   | 2026-08-04 live (integration suite): pull round-trips created rows verbatim incl. typed values + serial dates; id backfill live-verified                                                                                                                                           |
| 4   | **All entities seeded & fetched**                    |   ⬜   |                                                                                                                                                                                                                                                                                    |
| 5   | **Full write CRUD**                                  |   ✅   | 2026-08-04 live: create (atomic append, ids verified in-sheet via direct axios), sparse update (untouched cells survive), delete (bottom-up, idempotent re-delete)                                                                                                                 |
| 6   | **Foreign keys tested**                              |   🔄   | FK columns = TEXT columns holding ONE target `scr_` id, marked with `scratch-fk-target` developer metadata; schema round-trips the annotation. Single-valued only (`supportsManyToManyForeignKeys: false`)                                                                         |
| 7   | **Edge cases & quirks tested**                       |   ⬜   | See "Known quirks" below for the list to exercise live                                                                                                                                                                                                                             |
| 8   | **View(s) built**                                    |   🔄   | `google-sheets-default-view.ts`: sheet-order columns, hidden readonly Scratch ID last, checkbox/number cell types, serial-date columns render via the new generic `serial_date_to_iso` display transform + bidirectional codec                                                     |
| 9   | **OAuth**                                            |   ✅   | Live end-to-end 2026-08-04: consent → tokens → refresh all working. Redirect slug is `…/oauth-callback/connector/iapp_sheets` (the ws connector id kept its iApp-era slug; `sheets` 400s with redirect_uri_mismatch — hit live, fixed)                                             |
| 10  | **Integration test**                                 |   ✅   | 10/10 PASSING LIVE 2026-08-04 (`yarn test:integration -- google-sheets-connector`): hermetic throwaway-sheet suite — connect/URL-search/createTable/schema/CRUD/backfill/poison+recovery, all writes verified via direct axios. Not in CI (needs `INTEGRATION_TEST_*` GitLab vars) |

### TODOs — known pending tasks

- [x] **Creds** (Ryder, 2026-08-04): `GOOGLE_SHEETS_CLIENT_ID/SECRET` created + populated in Secret Manager (readable by the RO SA on `spv1eu-test`). Redirect slug must be `…/oauth-callback/connector/iapp_sheets` (fixed after a live redirect_uri_mismatch).
- [ ] **Logo**: `google-sheets-logo.svg` is checked in (a hand-drawn approximation, NOT the official mark) and the metadata URL `https://static.scratch.md/connector-icons/google-sheets.svg` already serves a 200 (something was uploaded there previously — likely from the Whalesync era). Verify what's live at that URL; if it's not a proper Google Sheets mark, replace it (`gcloud storage cp server/src/remote-service/connectors/library/google-sheets/google-sheets-logo.svg gs://spv1eu-production-static/connector-icons/google-sheets.svg --content-type="image/svg+xml"`) — or preferably swap the checked-in file for the official icon first.
- [x] **Live integration run** — 10/10 passing 2026-08-04. Two fixes came out of the first run: `fetchJsonTableSpec` now invalidates the describe memo (a spec fetch starts an operation chain, so structural changes/poison are always re-checked), and the record schema emits every property OPTIONAL (a `required` list would make enforce_schema warn on locally-created draft rows, which start `{}`).
- [ ] **Live Export audit** (`/test-live-export <source> GOOGLE_SHEETS`) once creds land — this connector is destination-first by design.
- [ ] Decide: hide the ID column (`hiddenByUser`)? Currently visible-but-gray. (Open question #1 in the design doc.)
- [ ] Flip `metadata.visible` → true after review + live verification (+ update the existing-connectors.md Visible cell).
- [ ] `values.append` behavior against pre-existing user sheets with gaps/filters — verify the append lands after the last data row (the appendCells alternative is gid-addressed if A1 table detection misbehaves).
- [ ] Access-token lifetime: the token is minted once per connector instantiation; a single pull running > 1h would 401 mid-run (same exposure as other OAuth connectors — noting for very large sheets).

## Identity model (the core design)

- **Table id**: `remoteId = [spreadsheetId, String(sheetId)]` — the numeric gid is stable across tab renames (Whalesync keyed by title; rename broke connections — deliberately avoided).
- **Row id — the "Scratch ID" column protocol** (`google-sheets-id-column.ts`):
  - Column A of a connected sheet is managed by Scratch: header `Scratch ID`, values `scr_<10>` (the shared `IdPrefixes.SCRATCH_ROW` generator). `idPath = scratch_id`.
  - Identified by column-dimension developer metadata `scratch-id-column` (travels with reorders) with exact-header-text fallback; a SHEET-level marker `scratch-sheet-setup` records "Scratch set this sheet up".
  - First contact (no markers): insert a fresh column A + style (gray, TEXT, clipped; darker bold header), freeze row 1, add a **warning-only protected range**, a header **note** (API can't anchor real threaded comments to cells), and both metadata markers — one atomic batchUpdate.
  - **Deleted/moved ID column ⇒ fatal, user-facing error** (sheet marker present but column gone/not-first). Never auto-recreated. Recovery recipe (in the error): insert a blank column A headed exactly `Scratch ID` — the header-adoption path re-recognizes it and pull-time backfill assigns fresh ids (records re-sync as new). Zero special-case recovery code.
  - **Backfill**: rows with data but a blank ID cell get ids generated during pull and written back **sparsely (only the blank cells), immediately, before records are handed to the callback** — minimal observe→stamp race window; no full-column rewrites (Whalesync's DEV-10395 churn lesson, adopted from day one).
  - **Duplicate ids** (user duplicated rows incl. the ID cell) fail the pull naming both row numbers — never guess which row is "real".
- **Field ids**: slugified row-1 headers (`google-sheets-headers.ts`). Reorder = same field; **rename = new field** (per spec); two headers slugifying identically = user-facing error (no silent `_2` suffixes). Empty-headered columns are ignored entirely. Column indexes are re-derived live before every write, never persisted.

## Value fidelity

- **Read**: `UNFORMATTED_VALUE` + `SERIAL_NUMBER` — typed scalars; date/time cells arrive as spreadsheet serial numbers (lossless, locale-free). Empty cells normalize to `null` (the API's `''`-vs-absent spelling of "empty" is ambiguous).
- **Write**: always `RAW` — no locale re-parsing, no formula injection.
- **Dates**: serials on disk; the new generic transformer pair `serial_date_to_iso` / `iso_to_serial_date` (shared-types `transform/serial-date.ts` + sync transformers + display arm + client-safe codec arms) converts at every boundary: grid display/edit, export from Sheets, and the Live Export destination pack (`x-scratch-suggested-in-transformer`).
- **Cells are scalars**: lists/objects in a record fail publish loudly (never silently stringified). multiSelect columns are comma-joined text by construction.
- Records/spec are addressed by `sheetId` via `*ByDataFilter` + `GridRange` everywhere except `values.append` (A1 with a title-quoting helper) — immune to tab renames and A1 quoting bugs.

## Live Export (destination)

- `createTable`: parent = spreadsheet id, or the `scratch-new-spreadsheet` pseudo-destination → `spreadsheets.create` (memoized per materialize batch so sibling tables share one new spreadsheet). New sheet gets the full ID-column setup + per-kind column treatments: checkbox validation (boolean), dropdown validation (select, non-strict), DATE/DATE_TIME ISO patterns, CURRENCY symbol patterns, TEXT for text-ish kinds, FK marker metadata.
  - **New-spreadsheet title**: `NormalizedCreateTablePlan.newParentName ?? "Scratch Export"`. sync-draft materialize passes `"<Source service> export"` (e.g. `"Airtable export"`; joined with `&` when a batch mixes sources) via the generic `createSchemaTablesSchema.newParentName` field — the connector stays source-agnostic and just consumes the suggested name.
  - **Blank default tab removed**: `spreadsheets.create` always seeds one empty `Sheet1`, and every table becomes its own sheet, so that tab would be left blank. The connector remembers its id (gid 0, proto3-elided → `?? 0`) and the FIRST created table's setup batch appends a `deleteSheet` for it (bundled in — no extra request; a spreadsheet must keep ≥1 sheet, so the delete waits for a real sheet). Covered in `google-sheets-connector.spec.ts`.
- `createFields`: appends headed columns after the last existing one (grows the grid when needed).
- Destination discovery: `listCreateDestinations` = new-spreadsheet pseudo-entry + known spreadsheets (from this connection's folders, via the new `ConnectorFactoryContext.listFolderTableIds`); `searchCreateDestinations` accepts a pasted spreadsheet URL.
  - **`created` / `remoteWebUrl`**: the new-spreadsheet pseudo-entry is the connector's only `created: false` destination — that flag (not the sentinel id) is how a UI renders "will be created", so no frontend has to know the string `scratch-new-spreadsheet`. `buildCreateDestinationRemoteWebUrl` returns `https://docs.google.com/spreadsheets/d/{id}/edit` for a real spreadsheet and `undefined` for the sentinel. Because a destination id can be a **pasted URL**, it goes through `parseSpreadsheetIdFromUrlOrId` rather than being interpolated raw.
  - **Provisioned-parent pin (idempotency)**: `createTable` returns `remoteParentId: [spreadsheetId]`, and sync-draft materialize pins it onto every placeholder in the group. The memo that makes sibling tables share one spreadsheet is per **connector instance**, and a fresh instance is built per `createTables` batch — so before this, a partial failure + retry provisioned a SECOND spreadsheet and split the export across two files.
- Capabilities: all logical kinds; `primaryField: null` (a designated primary is ordered into column B); `supportsManyToManyForeignKeys: false`; `requiresUniqueTableNames: true`; reserved field name `Scratch ID`; sheet-name limit 100.

## Adversarial review round 1 (2026-08-04, 8-angle multi-agent, pre-live)

Fixed in-branch: **gid-0 proto3 elision** (Google omits `sheetId: 0`/`startIndex: 0` from developer-metadata locations — markers on the default first tab were invisible, so the poison detector never armed; now handled via `columnIndexOfColumnMetadata`/`hasSheetSetupMarker` with a locationType guard); **qualified FK `linkedTableId`** (`<spreadsheetId>.<gid>`, never the bare gid — every first tab is gid 0 and the FK binder's fallback token matching could cross-wire spreadsheets); **reserved `scratch_id` slug** (a data column headed "Scratch ID"/"scratch-id" would have overwritten record ids); **createFields placement by observed width** (was: last _schema-visible_ column +1, which could overwrite an unheadered/symbols-headed user column); **intra-plan slug-collision detection** in createTable/createFields (two fields slugifying identically would have wedged the new table); **numeric ID-cell coercion unified** between pull and the update/delete row map; **scratch_id edits now throw** instead of being silently dropped (Sheets can't reject them, so we must); **serial-date parsing fails closed** (no more `Date.parse` fallback: `8/1/2025` would have parsed in the HOST timezone, `"45870"` as the year 45870; sub-ms fractions now truncated); **empty-string cells never render as the 1899 epoch**; **no positional resume cursor** (deliberate: row indexes shift under concurrent edits — a resumed pull could silently skip rows; full restarts are cheap and always correct); **describeSheet memoized per instance** + createFields reuses its columnCount (publish batches were paying 2 redundant describe requests each); **404/403-tolerant URL-paste search** (a long unspaced search term no longer errors the picker); **hint row filtered from listTables()**; **tokeninfo behind retry**; **currency symbols shared with Airtable's `currencySymbolFor`**; **dead type/state members pruned**.

Known limitations documented, deliberately NOT fixed in-branch (need Ryder's call / deeper layers):

- **`scratch-new-spreadsheet` sentinel is not resume-safe across materialize retries.** The created-spreadsheet memo is per connector instance; sync-draft materialize builds a fresh connector per `createTables` call, so a _partially failed and re-saved_ draft targeting "new spreadsheet" creates a SECOND spreadsheet (named "&lt;Source&gt; export") for the remaining tables. Deep fix: persist the resolved spreadsheetId back into the draft's `remoteParentId` at the schema-builder/sync-draft layer (a typed `{ createNew: true }` discriminator instead of a magic id string would also let generic code stop treating the sentinel as a real id). Happy-path (single batch) is safe.
- **Known-spreadsheet memory is folder-derived PLUS connect-form extras** (2026-08-05 URL-UX round): `listKnownSpreadsheetIds` unions `ConnectorAccount.extras.spreadsheetIds` (the URLs pasted on the OAuth connect form — durable) with ids derived from folders via `ConnectorFactoryContext.listFolderTableIds`. Remaining gap: a URL pasted later into the _picker_ is still only remembered while a folder for it exists (nothing writes extras after connect), and a reconnect/re-auth does not merge new URLs into extras (parity with YouTube's reauth path).
- **Listing fan-out**: discovery/list paths fetch each known spreadsheet's title (1 req/s limiter), capped at 20 spreadsheets per call; per-keystroke search re-fetches (connector instances are per-request, so no cache survives). Fine at expected folder counts; revisit with account-level caching if a connection accumulates many spreadsheets.
- **Per-cell update ranges**: updateRecords emits one gridRange per changed cell (single API call; payload could coalesce horizontally-contiguous runs — only worth it if wide-row updates show up in practice).
- **Pull pages the whole grid** (rowCount includes trailing empty rows): a grid manually grown to 100k rows with little data costs `rowCount/5000` reads per pull. Bounding by data extent needs a probe that can't miss id-less rows; revisit if real sheets hit this.

## Known quirks (to exercise live)

- No conditional writes / ETags anywhere in the API: updates and deletes trust row positions only for one back-to-back id-scan → write pair. A concurrent human reorder inside that window can hit wrong rows (industry-wide Sheets limitation; Whalesync refuses batched updates for the same reason — we keep batches small instead).
- Protection is warning-only — the file owner can always edit the ID column (we act as them). The poison detector is the real guard.
- Grid `rowCount` includes trailing empty rows (default 1000); pull pages the whole grid deliberately (never early-breaks on an empty page, so a blank block mid-sheet can't mask later rows as deletions).
- **"Human definition of blank" row filter (Ryder, 2026-08-05)**: a row WITHOUT a Scratch ID only becomes a record when some HEADERED column holds human-visible content — `''`, whitespace-only strings, `null`, `false` (a visually blank checkbox-validated cell), and the number `0` all do NOT count, and neither does content in headerless columns (invisible to the schema). Prevents id-minting/backfill on formatting residue (checkbox/validation ranges dragged below the data, stray zeros). A row that already CARRIES a `scr_` id keeps record-hood even when blank — it has identity, and dropping it would read as a remote deletion. Helpers + unit coverage: `cellValueCountsAsRecordData` / `rowCountsAsGoogleSheetsRecord` (google-sheets-connector.ts). The connect form's field description also documents the row-1 header requirement.
- `spreadsheets.create` puts the new file in the user's My Drive root; without Drive scope we can't move or rename-after (title rename via Sheets API is possible).
- Copied spreadsheets: developer metadata copies with the document, and the header fallback covers stripped copies — worth verifying live. Protections also copy: `describeSheet` reads `protectedRanges(protectedRangeId, description)` in its existing structure request, recognizes ours by description, exposes the live `scratchProtectedRangeId` on the description (the update/delete handle for any future repair — read fresh each time, never persisted), and the adoption path skips `addProtectedRange` when one already exists so copies don't accumulate duplicate warning dialogs. Developer-metadata ids need no stashing — that API updates/deletes by key lookup.
- Sheets quotas: 60 read + 60 write req/min/user — proactive 1 rps limiter + 429 retry with 20s default cooldown.

## Field types (what a column can be)

Sheets has no column types — only number formats + data validation. The schema keeps every data field `string | number | boolean | null` (formats are never validation constraints; a column can always hold anything) and carries the semantic type on `x-scratch-connector-data-type`: `checkbox` (BOOLEAN validation), `select` (ONE_OF_LIST), `date`/`datetime`/`time`/`currency`/`percent`/`number`/`text` (number format).

## Spreadsheet-URL collection UX (audited + reworked 2026-08-05, three rounds with Ryder)

The scope can't browse Drive, so the user must hand us spreadsheet URLs. Final design — URLs are FRONTLOADED; the table picker never asks for one:

1. **At connect (the only collection point for new URLs).** The OAuth connect form shows a REQUIRED "Spreadsheet URLs" section (`credentialFields.oauth` → `GOOGLE_SHEETS_SPREADSHEET_URL_FIELD`, the YouTube `additionalChannels` pattern) rendered as repeatable plus/minus rows — the generic `ConnectorSettingDefinition` type `'string-list'` (per-row regex via `itemPattern` = `GOOGLE_SHEETS_SPREADSHEET_URL_INPUT_PATTERN`, URL-only, no bare ids; `required` = ≥1 non-empty row; rows newline-joined into one string on the OAuth wire). Key `googleSheetsSpreadsheetUrls` matches `oauthInitiateOptionsSchema`; it rides the OAuth `state` payload and the callback splits it (`splitGoogleSheetsSpreadsheetUrlInput`) into **`ConnectorAccount.extras.spreadsheetUrls` — the rows VERBATIM** (`GoogleSheetsConnectorExtras`); ids are derived at read time (`spreadsheetIdsFromConnectorAccountExtras`). Required is CLIENT-side only — the server callback stays lenient so Whalesync-initiated Live Export flows (which bypass the form) still connect URL-less and use the "create new spreadsheet" destination. The field also carries `hideForCreateOnly: true` (DEV-11217): a create-only client — today the Live Export DESTINATION side, which always makes a new spreadsheet and never reads existing data — drops it entirely (connect form, reauthorize, and post-connect editor), so the wizard stops asking for URLs it would ignore. Scratch and the Live Export SOURCE side (which reads existing data) still render and require it. Re-auth with URLs typed on the form UNIONS into the existing rows (dedup by id; the reconnect form isn't prefilled, so replace would drop spreadsheets).
2. **Managing URLs afterwards: Edit Connection.** The field declares `extrasKey: 'spreadsheetUrls'` — the generic contract that makes a string-list field editable post-connect. The edit-connection modal (web) prefills the rows from `extras[extrasKey]` and REWRITES them on save (add and remove both work), via the update endpoint's existing generic `extras` field. No connector knowledge in the frontend: the key comes from metadata, the values are the user's own verbatim input.
3. **The table picker is LIST mode** (was SEARCH): every known spreadsheet's tabs, grouped under the spreadsheet title via `parentPath` (the modal's existing grouping), with per-spreadsheet select-all. Known = extras rows ∪ folder-derived ids, cap 20. No URL box. The LIST empty state shows `tableSearchInstructions` ("Edit the connection to add spreadsheet URLs…") — the modal falls back to its generic copy for connectors that don't set it. `searchTables` (paste-URL) still exists server-side but no UI drives it.

Verified live against Ryder's running dev server: `discoveryMode: LIST`, extras-seeded + folder-derived spreadsheets both listed with spreadsheet-title parentPath grouping. Untested hop (needs a real browser consent): the full connect-form → OAuth dance → extras write; identical to YouTube's proven path. Local dev connection `coa_S8WUAP6AI4` has extras hand-set (verbatim-URL shape) to the integration-test spreadsheet.

## Live Export destination audit round (2026-08-05, five sources)

`/test-live-export <SRC> GOOGLE_SHEETS` for **SANITY, PIPEDRIVE, AIRTABLE, STRIPE, SUPABASE** — every
run ended **100% published, `failedOperations: []`** (221 + 253 + 216 + 261 + 277 records) into fresh
sentinel-created spreadsheets, with values verified via the Sheets API (verify-google-sheets.mjs).
Per-source details live in each source's LIVE_EXPORT_AUDIT.md (GOOGLE_SHEETS sections).

Dest-side bugs found by the round, all fixed in-branch (see the round-1 commit + follow-ups):
created-field resolution (slug-keyed schema vs name-keyed plan), string-coerced booleans/numbers
(missing packs), INSERT_ROWS format inheritance (bold header leak / unformatted dates / displaced
checkboxes — Ryder's screenshots), ''-vs-empty cells (typed updateCells + null-skipping appends).
Cross-checks that PASSED: FK resolution to destination scr_ ids across co-created tables on three
sources (single + relational chains), epoch→ISO→serial date chain (Stripe), extreme dates, 2001/4001-char
texts, unicode/zero-width, comma-bearing selects, all-empty records, 200+-row pagination, CRUD mirror +
out-of-band-delete drift restore (Sanity).

Round findings NOT dest-side (recorded, not fixed here): second-run churn = DEV-10556 (22–246 ops,
scales with SOURCE value-shape instability — Airtable/Supabase small, Sanity/Pipedrive large);
`[core/schema-builder]` create-table name-collision pass isn't scoped to the create parent (spurious
" 2" suffixes after a same-connection retry — see pipedrive doc); audit-harness fixes shipped
(long-timeouts preload; FK keep-check now honors pg's dotted `schema.table` ids).

## Default view audit (2026-08-05, per Ryder — Live-Export-created tables focus)

Inspected the actual `views/default.json` written for created destination folders (supabase types table,
26 columns): header display names, sheet column order, number/checkbox cell types, serial-date columns
with logicalType + display transform + bidirectional codec, FK carried with qualified target, Scratch ID
readonly+hidden+last — all correct. Fixed: the injected `<source>_record_id` match-key column is now
HIDDEN by default (plumbing; still in the column picker — suffix heuristic on the slug). Known gaps,
deliberate: select columns render as plain strings (dropdown options aren't carried into the
schema/view — future: an options annotation could drive a select editor); TIME-format columns show raw
day-fraction serials (no time codec; rare, revisit on demand).
