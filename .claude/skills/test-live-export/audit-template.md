# Live Export audit — <SOURCE> (source)

> Copy to `server/src/remote-service/connectors/library/<source>/LIVE_EXPORT_AUDIT.md` on first run.
> One doc per SOURCE service; add a "Destination: X" section per destination audited
> (a multi-destination run — `/test-live-export <src> <d1>,<d2>` — appends one section each).
> Gates 1–5 are destination-independent (judge once); gates 6–12 are re-proved per destination.
> Every ✅ needs evidence ids (workbook / sync / routine-run / report path). No evidence, no ✅.

- Umbrella Linear issue: DEV-____ (`Live Export QA: <SOURCE> source`, project [MAJOR] Live Export)
- Credentials: `local/audit-creds/<source>.env` (burner account: <which account/workspace>)
- OAuth-only? <no / yes — connection provisioned via dusky UI, workbook wkb_…, connection coa_…>
- Seed script: `tools/live-export-audit/seeds/<source>/`
- Torture tables: <names + which value classes each covers>

## Gates

| # | Gate | Status | Evidence |
|---|---|---|---|
| 1 | Preflight (server, token, creds) | ☐ | |
| 2 | Recon: connector + View read, tables chosen | ☐ | |
| 3 | Torture data seeded + read back via service API | ☐ | |
| 4 | Plan audit: every downgraded field judged (finding or accepted) | ☐ | report path |
| 5 | FKs identified as foreignKey; links resolve on destination | ☐ | |
| 6 | First run: publish failures = 0 or all filed | ☐ | wkb / rrn |
| 7 | Destination-side spot check (≥3 records/table, via dest service API) | ☐ | |
| 8 | CRUD pass: edit / create / delete mirrored | ☐ | rrn |
| 9 | Pagination: 200+ record table fully synced (count matches) | ☐ | |
| 10 | Second run is a no-op | ☐ | rrn |
| 11 | Destination drift: out-of-band delete restored (or fails loudly) | ☐ | |
| 12 | Findings filed (project + `live-export-qa` label) or queued below | ☐ | |

## Destination: <DEST>

- Workbook: wkb_… · Sync: syn_… · Report: <path>
- Runs: rrn_… (initial), rrn_… (CRUD), rrn_… (second-run check)

### Findings

| Issue | Layer | Summary | Status |
|---|---|---|---|
| DEV-____ | view | | filed |

### Accepted downgrades (not bugs — text is the honest representation)

| Field | Type | Why accepted |
|---|---|---|

## Human remainder (not automatable — do before launch)

- [ ] OAuth connect flow in real UI (if applicable)
- [ ] Full dusky wizard pass: placeholders, field-picker warnings, run from UI
- [ ] Sign-off on proposed View changes

## Log

- <date> — <who/agent> — <what was done, what changed>
