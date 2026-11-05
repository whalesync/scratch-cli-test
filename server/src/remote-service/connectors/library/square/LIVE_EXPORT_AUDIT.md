# Live Export audit — SQUARE (source)

> One doc per SOURCE service; a "Destination: X" section per destination audited. Gates 1–5 are
> destination-independent (judged once); gates 6–12 are re-proved per destination. Every ✅ carries evidence ids.

- Umbrella Linear issue: [DEV-12740](https://linear.app/whalesync/issue/DEV-12740) (Square Live Export audit), project
  [MAJOR] Live Export. Findings are filed under it.
- Credentials: shared secret `square` in GCP project `whalesync-test-credentials` → `local/audit-creds/square.env`
  (`apiKey=` the sandbox access token; burner account: the "Whalesync Testing" app's Default Test Account sandbox
  seller).
- OAuth-only? No. The harness connects with the pasted sandbox token. The OAuth path was exported separately on test
  (run `rrn_mblCJQkn5n`, 552/552, see `STATE.md` → OAuth).
- Seed script: `tools/live-export-audit/seeds/square/seed.mjs` (idempotent) · CRUD pass:
  `tools/live-export-audit/seeds/square/crud-pass.mjs`.
- Torture tables: all 18 Square tables (Square's tables are fixed, so every one is exported).
  - Orders ×258, with every state, catalog and custom line items, modifiers, and taxes/discounts/tenders as arrays of
    objects. Payments ×204 (card, cash, and external, with tips). Both page past 100.
  - Customers ×30: every contact field, year-less birthdays, and a >4,000-character note with newlines, quotes, and
    HTML entities. Catalog: 10 items, 17 variations, categories, taxes, discounts, and a modifier list, with
    unicode/RTL/CJK/emoji names.
  - Refunds ×12, Invoices ×6 (published and drafts), Team Members ×3, Locations ×3.
  - Added 2026-11-05: Gift Cards ×4 and Gift Card Activities ×10 (activate, load, redeem, adjust, and deactivate),
    Subscriptions ×4 (card, invoice, canceled, and future start), and Payouts ×1 with Payout Entries ×80 (the sandbox
    settled one payout itself).

## Gates

| #   | Gate                                                                 | Status | Evidence                                                                                                                                            |
| --- | -------------------------------------------------------------------- | :----: | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Preflight (server, token, creds)                                     |   ✅   | Local server on this branch; the destination connection string needs `sslmode=disable` for the local Postgres                                       |
| 2   | Recon: connector + View read, tables chosen                          |   ✅   | All 18 tables (fixed set)                                                                                                                           |
| 3   | Torture data seeded + read back via service API                      |   ✅   | `seed.mjs` summary 2026-11-05; integration spec `square-connector.spec.ts` (27 green)                                                               |
| 4   | Plan audit: every downgraded field judged (finding or accepted)      |   ✅   | One downgrade, accepted (below). 22 links planned as foreign keys                                                                                   |
| 5   | FKs identified as foreignKey; links resolve on destination           |   ✅   | 22 FK constraints in `square_audit_2026_11_05`; payout entries 80/80, gift card activities 10/10, and subscriptions 4/4 join                        |
| 6   | First run: publish failures = 0 or all filed                         |   ✅   | `wkb_HHz3AoaTq9` / `syn_fH5eQBj8ry`: "Published 650 changes", `failedOperations: []`                                                                |
| 7   | Destination-side spot check (≥3 records/table, via dest service API) |   ✅   | 16 records of the four new tables compared field by field in Postgres: 0 mismatches. The 3,955-character edited note is identical                   |
| 8   | CRUD pass: edit / create / delete mirrored                           |   ✅   | `crud-pass.mjs` then rerun: 2 edits, 1 create, 1 delete, 1 gift card load (new activity + balance 7,500 → 8,277), all in Postgres                   |
| 9   | Pagination: 200+ record table fully synced (count matches)           |   ✅   | Orders 258/258, Payments 204/204; every table's row count equals Square's                                                                           |
| 10  | Second run is a no-op                                                |   ❌   | 21 Customer updates, then 4 on a later run: Square reorders `segment_ids` between calls — [DEV-12753](https://linear.app/whalesync/issue/DEV-12753) |
| 11  | Destination drift: out-of-band delete restored (or fails loudly)     |   ✅   | Deleted gift card activity `gcact_7da7482dfc0346c9b4754adf8f833caf` in Postgres; the next run recreated it with its values                          |
| 12  | Findings filed (project + `live-export-qa` label) or queued below    |   ✅   | DEV-12753, DEV-12754                                                                                                                                |

## Destination: POSTGRES (local, 2026-11-05)

A stand-in for Supabase, which shares the `pg-common` destination code. No Supabase or Notion test account existed.

- Workbook `wkb_HHz3AoaTq9` · Sync `syn_fH5eQBj8ry` · Square connection `coa_VZld1FM7ZB` · Postgres connection
  `coa_z1nFaKu4bY` · destination schema `square_audit_2026_11_05` in the local docker database `fable_qa_square_dest`.
- Runs: initial ("Published 650 changes"), second-run check ("Published 21 changes", all Customers), CRUD
  ("Published 41 changes": 2 creates, 38 edits, 1 delete), drift ("Published 5 changes": the restored activity, plus
  4 Customers re-published by DEV-12753). Every run had `failedOperations: []`.
- Column types: dates (`start_date`, `canceled_date`, …) are `date`; `*_at` are `timestamp with time zone`; money
  splits into a numeric amount and a currency; lists of ids are `text[]`; lists and objects (`phases`, `actions`,
  `line_items`, …) are `jsonb`; every link is a `uuid` foreign key with `ON DELETE SET NULL`.
- Deleting a customer that orders and payments still point at works: the publish clears those 16 links and then
  deletes the row. The warning it prints about them is wrong, and it repeats every run (DEV-12754).

### Findings

| Issue                                                     | Layer     | Summary                                                                                                | Status         |
| --------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ | -------------- |
| [DEV-12753](https://linear.app/whalesync/issue/DEV-12753) | transport | Square returns `segment_ids` in a different order on each call, so most customers re-publish every run | filed (Medium) |
| [DEV-12754](https://linear.app/whalesync/issue/DEV-12754) | core      | A link to a deleted record warns "left the field untouched" on every run, though the delete cleared it | filed (Low)    |

### Accepted downgrades (not bugs — text is the honest representation)

| Field                              | Type | Why accepted                                                                                                                                                                                                         |
| ---------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `payments.buyer_currency_exchange` | text | Square's spec references a `CurrencyExchange` schema it never defines, so the field is untyped. It's only set on cross-currency payments (none of the 204 in the sandbox), and a value would arrive as its JSON text |

## Not yet audited

- **Supabase and Notion** (DEV-12740's targets): no test account for either. Supabase uses the same `pg-common` code as
  the Postgres run above; Notion would be the first non-SQL destination.

## Human remainder (not automatable — do before launch)

- [x] OAuth connect flow in real UI (2026-11-04 on test, sandbox seller; see `STATE.md` → OAuth)
- [ ] Full dusky wizard pass: placeholders, field-picker warnings, run from UI
- [ ] Sign-off on proposed View changes (none proposed)

## Log

- 2026-10-26 — agent — First local SQUARE → POSTGRES export (14 tables, 551/551, 17 FKs); not recorded in a doc then.
- 2026-11-05 — agent — Added the four new tables (DEV-12741), then this audit against a local Postgres: 650/650
  published, 22 FKs, CRUD and drift gates pass; second run not a no-op (DEV-12753); misleading dangling-link warning
  (DEV-12754).
