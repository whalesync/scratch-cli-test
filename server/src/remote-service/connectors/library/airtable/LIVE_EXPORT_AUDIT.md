# Airtable — Live Export source audit

> NOTE: this doc was CREATED during the Google Sheets destination shakedown (2026-08-05) and covers
> only that round's scope — a torture-typed source export to GOOGLE_SHEETS. It is NOT the full
> /test-live-export source audit (no Notion/Supabase destination sections, no source-side CRUD pass
> yet). Treat unchecked gates as unrun, not failed.

- Torture tables (seeded by `tools/live-export-audit/seeds/airtable/seed.mjs`, base appGoopxI4Px4dyuv):
  `fable_qa_at_invoices` ×213 (all field types: text/long(2001/4001)/richText, currency −, number 0/big/precise,
  percent, checkbox, date + dateTime (extreme 0100/9999), single/multi select incl. comma-in-name options,
  links → contacts (multi) and → `fable_qa_at_hidden` (a table deliberately NOT exported), email/url/phone,
  unicode/zero-width, an all-empty record, 210 fillers for pagination), `fable_qa_at_contacts` ×3, `fable_qa_at_hidden` ×2.

## Destination: GOOGLE_SHEETS (2026-08-05)

Workbook wkb_H7FZD4vFpN (dest conn coa_Oh343fds0I cloned from coa_S8WUAP6AI4; sentinel "new spreadsheet"
parent). Report /tmp/audit-airtable-gsheets.json.

- **First run: 216/216 published, `failedOperations: []`.** `Hidden Ref` FK correctly dropped
  (target table not in export); `Contact` created as single-valued FK per the sheets capability
  (`supportsManyToManyForeignKeys: false`) and narrowed to the first link — accepted (DEV-10956 family).
- **Verified via Sheets API** (torture invoice, field-by-field): every scalar typed (currency −1234.5,
  qty 0, precision 0.12345678, percent 0.875, checkbox native true), date/dateTime as serials in
  formatted columns (incl. extreme serials), richText arrives as its markdown source text (honest for a
  text destination), select value with comma intact, multiselect comma-joined (comma-in-element ambiguity
  is the documented lossy case), unicode/zero-width intact, links resolved to destination `scr_` ids,
  injected `airtable_record_id` populated.
- **Second run: only 23 ops of churn** (vs 215/246 for the Sanity/Pipedrive rounds) — useful DEV-10556
  triage datapoint: churn scales with source-side value-shape instability, not with the sheets
  destination per se. The residual 23 likely = multiselect/link/'' classes; not chased per policy.
