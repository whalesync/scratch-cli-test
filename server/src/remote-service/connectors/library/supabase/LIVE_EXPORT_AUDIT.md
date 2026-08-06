# Supabase — Live Export source audit

> NOTE: created during the Google Sheets destination shakedown (2026-08-05); the original Supabase
> source audit (DEV-10931, blocker DEV-11071) predates this branch. This doc covers only the
> GOOGLE_SHEETS destination round.

## Destination: GOOGLE_SHEETS (2026-08-05)

Workbook wkb_VxCnBfbvrA (r2; r1 = wkb_hlRu8gvGFO, superseded) → spreadsheet
`1QZRLNc5cgl3TaQhRFMbwpOxQ8vPNK2vVn3PLh35M-rw`. Tables fable_qa.{authors,types,bulk,author_bios}
(the standing torture schema on the pooler project).

- **First run: 277/277 published, `failedOperations: []`.**
- **Relational FKs bind and resolve**: author_bios.{Author Id → scr_… of authors, Types Id → scr_… of types}
  verified via the Sheets API; the only dropped FK is types→fable_qa.hidden_refs (correct — not exported).
- **Harness fix this round** (`tools/live-export-audit/audit.mjs`): the keep-check for unresolved FK
  fields matched only bare leaf table ids, silently dropping pg's qualified `schema.table` linked ids
  (DEV-11071 family) BEFORE the server's binder ever saw them — r1's dropped authors/types FKs were this
  harness artifact, not a product bug. Now matches the server's own dot-joined-suffix token convention.
- pg type coverage: int/smallint/real/double → typed numbers; bigint/numeric → text (their pg-side
  declared kind — accepted); bool native; date/timestamp/timestamptz → serials in formatted columns;
  json/arrays → text (accepted downgrades per plan notes); 2001/2500-char texts intact.
- **Second run: 22 ops churn** (DEV-10556 family; notably small — same signal as the Airtable round:
  churn tracks source value-shape instability, not the sheets destination).
