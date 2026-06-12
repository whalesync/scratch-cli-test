# GENERIC_API — per-service coverage docs

## Tested services (central status)
The single source of truth for every service tested against the generic connector. **Each `/test-generic-connector` run must add or update its row here.** One line per service; link to its full coverage doc.

Status: 🟢 **green** — works well (fetches cleanly, little/no `overrides`, few/no unsupported entities) · 🟠 **amber** — works with caveats (needs per-endpoint `overrides`, or some notable entities aren't fetchable) · 🔴 **red** — mostly unsupported (auth / pagination / response shape incompatible).

| Service | Status | Notes |
|---|:--:|---|
| [CompanyCam](./companycam.md) | 🟢 | 9 fetchable entities (incl. **Documents** = the UI "Files" tab), **zero overrides** (page pagination + bare arrays + string `id` auto-detected). 2 unsupported ❌: ChecklistTemplates + Pages (both 302→login, not token-accessible). Pagination walked + verified at `per_page=2` (22/22 ids, no dupes). |
| [Quo (OpenPhone)](./quo.md) | 🟠 | Core entities fetch (phone numbers, users, contacts, conversations, webhooks, custom fields) but **require cursor `overrides`** (`pageToken`/`nextPageToken` not auto-detected). **Messages & Calls can't be listed** — require `phoneNumberId`+`participants` scoping. Auth = `raw`. |

---

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
