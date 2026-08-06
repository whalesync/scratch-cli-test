# Stripe — Live Export source audit

> NOTE: this file was created during the Google Sheets destination shakedown (2026-08-05) on the
> google-sheets-connector branch; the full Stripe source audit (DEV-10930, other destinations,
> findings DEV-11144..11149) predates this branch's fork and lives with that work. This doc covers
> only the GOOGLE_SHEETS destination round below.

## Destination: GOOGLE_SHEETS (2026-08-05, sheets-connector shakedown round)

Workbook wkb_BDloMlsQiD (dest conn cloned from coa_S8WUAP6AI4; sentinel new-spreadsheet parent) →
spreadsheet `13peTO-wXgPr99-ifkJTel7BAdefZOw1c1vicwTu-GRs`. Tables Products/Customers/Prices
(standing fable_qa torture data from the original audit).

- **First run: 261/261 published, `failedOperations: []`, zero downgrades, zero dropped FKs.**
- **Epoch-date chain verified end-to-end** (the class this source was previously blocked on, DEV-11145):
  Stripe `created` epochs arrive as serial numbers in DATE_TIME-formatted columns
  (`epoch_to_iso` source unpack → `iso_to_serial_date` sheets pack), e.g. Created=46233.7748…
- Typed values throughout (booleans native, numbers numeric); `unit_amount_decimal` stays the string
  Stripe returns (honest — it's a string in their API); Price→Product FK resolved to destination scr_ id.
- **Second run: 110 ops churn** — DEV-10556 family; not re-filed.
- CRUD/drift: destination-side mechanics proven in the SANITY→GOOGLE_SHEETS pass this round; not repeated.
