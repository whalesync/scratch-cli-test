# Deferred follow-ups — schema validation (DEV-10453) & create-schema API (DEV-10378)

- **Status:** Planned
- **Created:** 2026-06-18
- **Author:** Chris Hoefgen
- **Linear:** [DEV-10453](https://linear.app/whalesync/issue/DEV-10453) · [DEV-10378](https://linear.app/whalesync/issue/DEV-10378)

> **Why this note exists.** Three plans were resolved on 2026-06-18 and moved to
> `docs/plans/resolved/`. Their core work shipped, but each left genuine deferred
> follow-ups that would otherwise be lost when those plans are eventually deleted.
> This is a durable carry-over of those items only — see the resolved plans for full
> context, evidence, and code pointers.

## Source plans (resolved)

- [`resolved/2026-06-17-dev-10453-finding3-validation-noise.md`](../resolved/2026-06-17-dev-10453-finding3-validation-noise/2026-06-17-dev-10453-finding3-validation-noise.md)
- [`resolved/2026-06-17-dev-10453-pipedrive-readonly-validation.md`](../resolved/2026-06-17-dev-10453-pipedrive-readonly-validation/2026-06-17-dev-10453-pipedrive-readonly-validation.md)
- [`resolved/2026-06-10-create-schema-api.md`](../resolved/2026-06-10-create-schema-api/2026-06-10-create-schema-api.md)

## Schema validation (DEV-10453)

- **Server-side publish hard-gate (D-ii).** Validation auto-apply is **desktop-only**
  today (warn-level). Implement the dormant `Connector.validateFiles`
  (`server/src/remote-service/connectors/connector.ts` — defined but never called) or
  a `PublishSchemaValidatorService`, and call it before dispatch in
  `publish-plan-run.service.ts` to block schema-violating records across desktop +
  CLI + web. Decide **warn vs block**.
- **CLI/web parity.** Same gap as above from the client side — the read-only-edit
  warning surfaces only in desktop. D-ii would cover all clients.
- **Honor deliberate validator removal.** Removing `enforce_schema` via the UI is
  re-seeded on the next load. To respect deliberate removal, add a sibling-marker
  mechanism (a `noop:` validator entry won't work — the Rust dispatcher `bail!`s on
  unknown validator kinds).
- **Seed scope.** Currently seeds every leaf folder; consider seeding only folders
  that have a `schema.json` (harmless either way — `enforce_schema` no-ops without a
  schema).
- **Per-connector verbatim-schema whack-a-mole.** The noise was fixed by matching
  each connector's schema to its verbatim data (Pipedrive, Postgres, Webflow, Moco so
  far). Other connectors with verbatim records likely have the same latent strictness;
  fix as surfaced. The connector-agnostic alternative (Option A — scope the seeded
  validator to the read-only check only) remains available if per-connector upkeep
  becomes a burden.
- **Trim speculative Pipedrive read-only entries.** Decide whether to keep
  `private`/`marked_as_done_time` in `ENTITY_READONLY_FIELDS.activities` (harmless if
  the metadata never surfaces those codes) or trim to metadata-confirmed codes.

## Create-schema API (DEV-10378)

- **Other connectors opt into the seam.** Only the **Postgres** connector implements
  `supportsSchemaCreation` / `createTable` / `createFields` (DEV-10381). Other
  connectors return `not_supported` until they opt in.
- **Concurrency precondition (#7 — `NEEDS FURTHER REVIEW`).** The
  `materializeLocally` / `/fields` lock gate was not implemented; the exact set of
  blocking states (and whether remote creation should also be gated) is unsettled.
- **`refreshLocalSchema`.** Accepted in the contract but a no-op TODO; meaningful only
  once a real connector executes field creation against a materialized folder.
- **Remote existing-field-name check.** For tables not materialized locally, the
  case-insensitive name check needs a connector fetch — deferred to the connector pass.
- **`TableView` (`TablePropertyType`) hints in plan generation.**
  `inferLogicalFieldType` accepts a hint, but the service doesn't supply one yet (no
  stored-view getter); inference currently uses JSON-Schema type + `x-scratch-*` only.
- **PostHog tracking.** Audit logging is wired; PostHog is deferred (it only fires on
  real creation).
- **Frontend UI / SWR hooks and the Rust CLI.** Out of scope for the contract pass.
