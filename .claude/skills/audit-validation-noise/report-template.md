# `enforce_schema` validation-noise audit — <workspace name>

- **Workspace:** `<absolute path>`
- **Date:** <YYYY-MM-DD>
- **Connections audited:** <list, e.g. Webflow, WordPress>
- **Method:** read-only — SQLite `SELECT`s against `.repos/*.db`, on-disk `schema.json` + record files,
  connector source + git history, public API docs. No workspace file changed; no pull/publish/push.

## Determination (one-paragraph answer)

<Lead with the verdict the user wants: are these legitimate schema issues / false positives, or bad
data? Note whether they are stale (clear on re-pull), live connector bugs, or an old desktop build.>

---

## Per connection

### <Connection name>

- **Validation table:** `<validation_results__v4 | validation_results_v1 | …>`  ← desktop-build vintage
- **Totals:** <N> errors, <N> warnings (`validator_kind='enforce_schema'`)

| field_path | message (short) | level | count | folder(s) |
|---|---|---|---|---|
| `…` | `…` | error | N | `…` |

#### Evidence per shape

**`<field_path>` (×N)**
- **Verbatim value** (from `<folder_path>/<filename>`): `<the real value — null / "" / object / …>`
- **Schema fragment** (`…/schema.json`, `generatedAt <ts>`): `<the constraint that rejects it>`
- **API docs:** <citation — does the service legitimately return this shape? link/quote>
- **Classification:** <one of:>
  - 🟢 **Stale-schema noise** — schema predates connector fix `<commit>`; clears on re-pull (server ≥ that fix).
  - 🟠 **Live connector-schema false positive** — schema is current but stricter than the verbatim shape; needs a connector-schema fix.
  - 🔵 **Old desktop build** — top-level `""`/`null` already masked by the current validator; update the desktop binary.
  - 🔴 **Genuine bad data** — value is not what the API should return; surface to user, do NOT loosen the schema.

---

## Recommended remediation

- **Re-pull (no code):** <connections/tables whose noise is stale and clears on re-pull>
- **Update desktop build (no code):** <if an old validation-results table vintage is the cause>
- **Connector-schema fix (+ regression test):** <file:area to change; the verbatim shape to accept; link any tracking issue>
- **Data fix:** <only for genuinely bad data — describe; never auto-fix>

## Safety attestation

Read-only audit. No workspace file was modified, no production Scratch system was contacted, and
nothing was pulled, published, or pushed. Any code changes (if requested) are in the repo's connector
code only, never the workspace data.
