# Live Export audit — QUICKBOOKS (source)

> Gates 1–5 are destination-independent (judged once, on NOTION); gates 6–12 are re-proved per
> destination. Every ✅ carries evidence ids. **All three destinations complete** — see the
> [Log](#log). Gates 5 and 10 fail and gate 9 is untested, so QuickBooks is **not launch-ready**;
> DEV-11132 and DEV-11133 are the blockers.

- Umbrella Linear issue: **DEV-10929** (`Live Export: Launch QuickBooks`, project [MAJOR] Live Export).
  Per the requester, ALL findings from this audit are filed as **children of DEV-10929**
  (rather than a separate `Live Export QA: QUICKBOOKS source` umbrella).
- Credentials: **OAuth-only** — `local/audit-creds/quickbooks.env` is documentation only.
- QBO company: realm `9341457409764164`, **sandbox** ("Sandbox Company US b9ec").
- Seed script: `tools/live-export-audit/seeds/quickbooks/` (`seed.mjs` + `qbo-client.mjs`).
- Torture tables: **Customer** (unicode/control chars/max-length notes/self-FK/inactive/all-empty),
  **Invoice** (FK to Customer, `Line[]` array with nested Item FK, date extremes, 4000-char note,
  out-of-export `SalesTermRef`), **Item** (decimal precision, enum type, FK to Account),
  **Account** (FK target, 89 rows), **Vendor** (second name-list, for per-entity vs generic triage).

## Environment notes (affect how to reproduce)

- **QuickBooks is OAuth-only**, so `audit.mjs` cannot create the source connection. The connection
  was established by a human in workbook `wkb_kbxXKqnzF7`; because that workbook was off-limits for
  testing, `tools/live-export-audit/clone-oauth-connection.mjs` copies the encrypted credential blob
  and `extras` into disposable audit workbooks (mirrors `OAuthService.createOAuthAccount`).
- **The dev server used (`san-jose`) has no `QUICKBOOKS_CLIENT_ID`/`_SECRET` in `server/.env`**, so it
  cannot refresh a QBO token; any pull >1h after connect fails with
  `System OAuth app credentials for QUICKBOOKS v1 are not configured`. This is a **test-environment
  gap, not a product bug** — worked around with
  `tools/live-export-audit/seeds/quickbooks/refresh-connection-token.mjs`, which mints a token
  out-of-band and re-encrypts it into the connection.
- QBO is a **static-schema** service: no custom tables/fields, so torture lives in `fable_qa_*`
  RECORDS of existing entities rather than a dedicated table.

## Gates

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Preflight (server, token, creds) | ✅ | server :3010 (san-jose `dist`, `4d444e4ef`); quickbooks/notion/supabase/airtable/sync/transform-picker byte-identical to this worktree |
| 2 | Recon: connector + View read, tables chosen | ✅ | 5 tables chosen for max type + FK coverage |
| 3 | Torture data seeded + read back via service API | ✅ | 18 `fable_qa_*` records; all values verified verbatim in QBO |
| 4 | Plan audit: every downgraded field judged | ✅ | 24 `Can't unpack…` downgrades + 2 `needs_target` judged; SUPABASE/AIRTABLE reports (the NOTION first-run report was lost to the server wedge) |
| 5 | FKs identified as foreignKey; links resolve | ❌ | **DEV-11132** + **DEV-11133** — zero relations on ALL THREE destinations |
| 6 | First run: publish failures = 0 | ✅ | NOTION `rrn_MerdAQg4Tx`, SUPABASE `rrn_D7OnCwhq8W`, AIRTABLE `rrn_RrZuJBC4m5` — 211/211 created, 0 failed on each |
| 7 | Destination-side spot check via dest API | ✅ | `verify-notion.mjs`, `verify-supabase.mjs`, Airtable meta+records API |
| 8 | CRUD pass: edit / create / delete mirrored | ✅ | all three: 1 create + 1 delete + edits, 0 failed. Verified on each destination's own API |
| 9 | Pagination: 200+ record table fully synced | ⚠️ | largest table = Accounts (89). QBO `PAGE_SIZE` is 1000, so >1000 rows are needed to exercise the boundary — **not tested** |
| 10 | Second run is a no-op | ❌ | churn on all three: NOTION 211/211, AIRTABLE 176/211, SUPABASE 41/211 edits — generic **DEV-10556** (evidence commented there, not re-filed) |
| 11 | Destination drift: out-of-band delete restored | ✅ | record deleted directly on each destination; next run re-created it (1 create), values intact |
| 12 | Findings filed under DEV-10929 | ✅ | DEV-11132, DEV-11133, DEV-11134, DEV-11135 |

## Post-fix verification (2026-07-30, commit `7afd6197e`)

Re-verified against a **fresh** workbook `wkb_tGY0Ue7IZu` / connection `coa_U30WiD596F` → SUPABASE
(a rerun on the original workbooks would not re-plan the destination schema). Server: mumbai
`b04563b66`, which contains the fix. Report `/tmp/postfix-supabase.json`.

| Issue | Before | After |
|---|---|---|
| DEV-11132 | 0 FK constraints | `Invoices 2.CustomerRef` → `Customers 3.id`; `Items 2.{Asset,Expense,Income}AccountRef` → `Accounts 4.id`. Values resolve — all 5 `fable_qa_INV*` JOIN to `fable_qa_c05_all_fields`. |
| DEV-11133 | `ParentRef` dropped | `Customers 3.ParentRef` → `Customers 3.id` and `Accounts 4.ParentRef` → `Accounts 4.id`; `fable_qa_c07_subjob` resolves to parent `fable_qa_c06_parent`. |
| DEV-11134 | `Notes`/`Title`/`Suffix` absent | columns present **and populated** — `fable_qa_c04_notes_2000` has all 2000 chars. |
| DEV-11135 | `{"Address":"…"}` | `PrimaryEmailAddr` = `fable-qa+c05@example.com`; `PrimaryPhone`/`Mobile`/`Fax`/`WebAddr` likewise plain. `BillAddr` still whole, as designed. |

No regression: **211/211 created, 0 failures** — no cascade failures through the new relations.
Unit suites: 172/172 and 3281/3281 green; `yarn typecheck` clean.

### Behaviour trade-off introduced by the fix — worth knowing

A `*Ref` whose target table is **not in the export** is now **dropped** rather than landing as its
`.name` string. `Vendor.TermRef`, `Customer.SalesTermRef`, `Customer.DefaultTaxCodeRef`,
`Customer.PaymentMethodRef` and `Invoice.SalesTermRef` all report
`needs_target — links to "Term"/"TaxCode"/"PaymentMethod", which isn't in this plan`, and no column
is created. Before the fix they arrived as useful text (e.g. `SalesTermRef` = `"Due on receipt"`).

This is the documented `needs_target` contract — the field survives the plan as *available with an
unmet requirement*, and in the dusky wizard the user is prompted to co-create or map the linked
table. So it is correct in the product flow, and the fix is a clear net win. But an unattended
export that doesn't include Term / TaxCode / PaymentMethod now loses those values where it
previously kept a readable label. Worth a product decision on whether to fall back to the `name`
text when a link target can't be bound. (The `needs_target` messages now correctly say `"Term"`
raw-cased, which is itself proof DEV-11133's casing fix landed.)

`CurrencyRef` is unaffected — it carries no FK annotation and still maps to text.

## Cross-destination differential (the layer-attribution instrument)

Every finding below reproduces on **all three** destinations, which rules out the destination
packs and puts each fix upstream. Crucially, each destination is also proved capable of the thing
QuickBooks fails to do, using a **different source** into the **same destination account**:

| Destination | QuickBooks result | Control (another source, same destination) |
|---|---|---|
| NOTION | 0 `relation` properties across 5 DBs | Pipedrive Deals → `Organization`, `Contact person`; Zoho Contacts → `Account Name`, `Reporting To` |
| SUPABASE | 0 FK constraints across 5 tables | Zoho `Accounts."Parent Account"` → real FK to `Accounts.id` |
| AIRTABLE | 0 `multipleRecordLinks` fields | Wix Blog `Blog Posts 2` → `Author`, `Categories`, `Tags`, `Related posts` |

## Destination: NOTION

- Workbook `wkb_36g4M3FdUF` · source conn `coa_qWv4r4lkMv` · dest conn `coa_zEcB8sbQXZ` · sync `syn_CXRUPmt1gz`
- Runs: `rrn_MerdAQg4Tx` (initial, 211/211 created), `rrn_sBiXPCqnQ0` (orphaned by server restart, cancelled), `rrn_AREkKeFFTm` (second-run check)
- Notion databases: Customers `8dcf9fc9…`, Invoices `040f6ab4…`, Items `b3763533…`, Accounts `bac8ed6e…`, Vendors `3769da91…`

### Findings

All findings apply to all three destinations (see the differential table above), and all are
filed as children of **DEV-10929**.

| Issue | Layer | Priority | Summary |
|---|---|---|---|
| [DEV-11132](https://linear.app/whalesync/issue/DEV-11132) | view | High | Every named `*Ref` is flattened to its `.name` string, **silently** discarding the foreign key. The View's `REF_SUBFIELDS`/`selectedSubfield` rewrites the plan's `sourcePath` to `CustomerRef.name`, so the `X_SCRATCH_FOREIGN_KEY_OPTIONS` annotation on the parent object is never consulted — and it is reported as a clean `text` mapping with no downgrade note. |
| [DEV-11133](https://linear.app/whalesync/issue/DEV-11133) | transport | High | The two refs that *do* reach FK resolution (`Customer.ParentRef`, `Account.ParentRef`) fail with `needs_target` "links to \"customer\", which isn't in this plan" — because `linkedTableId` is lower-cased while the in-plan token from `linkedTableIdCandidateTokensForRemoteTableId(['Customer'])` is raw-cased. Column dropped entirely. |
| [DEV-11134](https://linear.app/whalesync/issue/DEV-11134) | transport | High | Fields QBO returns but the hand-maintained static schema omits are silently never exported — `Customer.Notes` (2000 chars of user content), `Title`, `Suffix`, 2 Invoice booleans. Systemic: `additionalProperties: true` lets them land on disk while the View, built from `schema.properties`, never makes a column. |
| [DEV-11135](https://linear.app/whalesync/issue/DEV-11135) | view | Medium | Single-value wrapper objects exported as raw JSON — `PrimaryEmailAddr` → `{"Address":"…"}`, `PrimaryPhone`/`Mobile`/`Fax`, `WebAddr`, `BillEmail`, `CustomerMemo`. Carries a downgrade note, so visible rather than silent. |
| [DEV-10556](https://linear.app/whalesync/issue/DEV-10556) | core | existing | Second-run republish churn. Evidence **commented**, not re-filed per source. Notable: the churn rate is destination-dependent for an identical source (Notion 100%, Airtable 83%, Supabase 19%). |

### Accepted downgrades (not bugs — text is the honest representation)

| Field | Type | Why accepted |
|---|---|---|
| `BillAddr` / `ShipAddr` | rich_text JSON | Composite address with no single useful inner value; JSON is honest. (Flattening to subfields would be a nice-to-have, not a defect.) |
| `Line` (Invoice) | rich_text JSON | Array of heterogeneous line-detail objects; no destination type fits. Its nested `ItemRef` FKs are covered by F1. |
| `CustomField`, `LinkedTxn`, `TxnTaxDetail`, `DeliveryInfo` | rich_text JSON | Structured QBO envelopes with no scalar equivalent. |
| `EmailStatus`, `PrintStatus` | rich_text | Small enums; `select` would be nicer but text is not wrong. |

### Verified NOT bugs (proved, do not file)

- **Zero-width characters stripped** — direct experiment against Notion's own API: writing
  `A<ZWSP>B<ZWSP>C` and reading it straight back returns `ABC`. Notion strips them; not ours.
- **4000-char `Invoice.PrivateNote`** round-tripped intact through Notion's 2000-char rich_text cap.
- **Date extremes** `1901-01-01` / `2099-12-31` round-tripped exactly (no DEV-10960 here).
- **Numbers** `12345.6789`, `9999999.99`, `0`, `0.01`, `60.5` all exact.
- **Deactivated customer not pulled** — QBO's `SELECT *` excludes `Active=false`, consistent with
  the connector's deactivate-as-delete semantics. Re-check under the delete-mirroring pass (gate 8).
- **`sparse` in Vendor data but not the schema** — QBO envelope field, correctly hidden.

### Source-side quirks observed (QBO's own behaviour, not our bugs)

- `Vendor.BillAddr` rejects `Country` (HTTP 400) though `Customer.BillAddr` accepts it.
- Deactivating a name-list record makes QBO rename it to `<name> (deleted)`.
- QBO auto-appends a `SubTotalLine`: a 4-line invoice reads back with 5 `Line` elements.

## CRUD pass (gate 8) — `tools/live-export-audit/seeds/quickbooks/crud-pass.mjs`

One round of source-side changes through QBO's own API, replayed into all three workbooks:

| Change | Source mutation | Result on every destination |
|---|---|---|
| EDIT scalar | `fable_qa_c03_control_chars.CompanyName` → `"CRUD PASS edited company name"` | ✅ applied |
| EDIT long text | `fable_qa_INV03.PrivateNote` → 3029 chars | ✅ applied, all 3029 chars (incl. through Notion's 2000-char rich_text cap) |
| CREATE | new Customer `fable_qa_c09_crud_created` | ✅ appeared |
| DELETE | `fable_qa_c01_minimal` deactivated (`Active: false`) | ✅ mirrored as a delete |

Publish counts — NOTION `1 create / 210 edits / 1 delete`, SUPABASE `1 / 42 / 1`,
AIRTABLE `1 / 175 / 1`; `failedCount: 0` on all three. Verified by reading each destination's
own API, not our pull.

**The delete case is worth calling out as a PASS.** QBO has no hard delete for name-list
entities — the connector's "delete" is `Active: false`, and QBO additionally renames the record
to `<name> (deleted)` and drops it from the default `SELECT *` scope. So a deactivated customer
simply disappears from the pull, and the engine correctly interprets that as a delete and mirrors
it. Earlier in the audit this looked like it might be a silent-data-loss bug; the CRUD pass shows
the end-to-end behaviour is right.

## Destination-drift pass (gate 11)

`fable_qa_c02_unicode` was deleted **out-of-band, directly on each destination** (SQL `DELETE` on
Supabase, page archived via the Notion API, record deleted via the Airtable API), then each sync
was re-run.

Result: **restored, not silently lost.** Each run planned and executed exactly `1 create`, and the
restored row came back with full fidelity — `GivenName` `"🎉🇯🇵 中文测试 مرحبا بالعالم"`, zero-width
characters still present on Supabase, and the original match key `quickbooks_record_id = 87`.

## Destination: SUPABASE

- Workbook `wkb_NaU0mwVkpM` · source conn `coa_qRQ4ZFnzQR` · dest conn `coa_LyS6MVqhGX` · sync `syn_jHP3kdmBM2`
- Runs: `rrn_D7OnCwhq8W` (initial, 211/211 created, 0 failed) · second-run check: 41/211 edits
- Tables created: `Customers` (32 cols), `Invoices` (31), `Items` (17), `Vendors` (25), **`Accounts 3`** (13)
  — note the plan created `Accounts 3` rather than adopting the pre-existing Zoho `Accounts`/`Accounts 2`
  in the shared QA schema, so there was no cross-audit contamination.
- Report: `/tmp/audit-qbo-supabase.json`

Same four findings as NOTION, no destination-specific ones. Scalar typing is correct
(`Balance` `double precision`, `Active`/`Taxable`/`Job` `boolean`, dates as dates).
**Zero FK constraints** on any of the five tables.

Useful differential from this destination: **zero-width characters are preserved here**
(`FamilyName` = `'​zero​width​'`, len 12), which — together with the direct
Notion-API experiment — proves our pipeline is clean and Notion is what strips them.

## Destination: AIRTABLE

- Workbook `wkb_iA2FnvZhYc` · source conn `coa_IAz4dotu5R` · dest conn `coa_5YBPOcQlH9` · sync `syn_4lqSW0b9gd`
- Base `appGoopxI4Px4dyuv` ("Cetacean Invoicing", auto-picked first create-destination)
- Runs: `rrn_RrZuJBC4m5` (initial, 211/211 created, 0 failed) · second-run check: 176/211 edits
- Report: `/tmp/audit-qbo-airtable.json`

Same four findings, no destination-specific ones. Typing is correct (`Balance` `number`,
`Active` `checkbox`). **Zero `multipleRecordLinks` fields** on any of the five tables, while the
Wix Blog tables in the same base carry five — the control for DEV-11132.

## Not launch-blocking, but worth knowing

- **Pagination is genuinely untested (gate 9).** The connector pages with
  `STARTPOSITION`/`MAXRESULTS` at `PAGE_SIZE = 1000` and derives `hasMore` from
  `entities.length === maxResults`. The largest table in the sandbox is Accounts at 89 rows, so the
  page boundary was never crossed. Covering it means seeding >1000 records into one entity (QBO's
  batch endpoint does 30/request, so ~34 calls) — cheap to do, but it also makes every subsequent
  publish in the audit an order of magnitude slower, so it was deferred rather than skipped silently.
- **A routine run orphaned by a server restart blocks its routine indefinitely.** When the dev
  server restarted mid-publish, `rrn_sBiXPCqnQ0` stayed `running` for 2.7h and every retrigger
  returned `409 "Routine … already has an active run"`. There is no stale-run reaper; the product's
  own `POST /workbooks/:id/routine-runs/:runId/cancel` clears it. Recoverable, so not filed — but a
  deploy landing mid-publish would wedge a customer's sync until someone cancels it by hand.

## Human remainder (not automatable — do before launch)

- [ ] OAuth connect flow in the real UI — including the **company picker**: Intuit only shows a
      company chooser when the signed-in user administers >1 eligible company, and a Scratch
      connection is bound to exactly one `realmId`. Confirm the intended UX for multi-company users.
- [ ] Full dusky wizard pass: credential placeholders, field-picker warnings vs plan notes, run from UI
- [ ] Sign-off on the proposed View changes (DEV-11132, DEV-11135)
- [ ] Add `QUICKBOOKS_CLIENT_ID`/`_SECRET` to whichever dev server the audit runs against

## Log

- 2026-07-30 — Claude — First full audit pass across NOTION, SUPABASE and AIRTABLE.
  Cloned the OAuth connection into three disposable workbooks (source workbook `wkb_kbxXKqnzF7`
  never touched); seeded 18 torture records; all three first runs clean at 211/211 created,
  0 failed. Filed DEV-11132/11133/11134/11135 under DEV-10929 and commented churn evidence on
  DEV-10556. CRUD and destination-drift gates pass on all three. Gate 9 (pagination) deferred.
  Two interruptions worth noting for the next run: the dev server wedged for ~5 min mid second-run
  (self-healed; the orphaned routine run had to be cancelled via the API), and the server's
  `.env` lacked `QUICKBOOKS_CLIENT_ID`/`_SECRET` so it could not refresh QBO tokens —
  worked around with `refresh-connection-token.mjs`.
