# GENERIC_API — per-service coverage docs

One markdown file per external service tested through the read-only **GENERIC_API** connector
(e.g. `linear.md`, `pipedrive.md`), generated and maintained by the **`/test-generic-connector`**
skill. Each doc records, for that service: the connection config (`extras`) used, the entities
mapped, **which entities can and cannot be fetched (with the reason)**, observed reference fields
(the connector has no foreign keys), a seed→fetch verification log, and improvement candidates
triaged through the skill's generality gate.

- **Template + full process:** `.claude/skills/test-generic-connector/` (`SKILL.md`,
  `service-coverage-template.md`). The template is timestamp-versioned; each doc records the
  `Template version` it was reconciled to, so coverage is answerable "as of which date".
- **Connector-wide improvement plans** promoted from these docs live in the sibling
  `../PLAN.md` / `../ARCHIVE.md` (the `/connector-build` PLAN flow). One-off, service-specific
  quirks are **declared unsupported here**, never branched into the connector.
