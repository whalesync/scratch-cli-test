# Provisioned connectors — ready for `/connector-build-execute`

Connectors whose **provisioning is finished**: a test account exists, secrets are stored in `connector-build/.env.connector-build`, and the API token has been **validated (HTTP 200)**. The build step can begin on any of these. Each has a detailed record in [`provisioning-notes/<service>.md`](./provisioning-notes/) (folded into the connector's `STATE.md` and deleted when `/connector-build-execute` starts). Candidates **not yet** here live in [`queued-connectors.md`](/connector-build/queued-connectors.md).

**Gate legend** — **Payment:** 🟢 Free-Tier · 🟡 Trial-NO-CC · 🔴 Trial-CC. **Reg-flow:** ✅ unblocked · ⛔ blocked · 👤 1-off-human-gate (one human CAPTCHA click, then autonomous).

| Service | Type | Test env vars | Pay | Reg | Validated endpoint (auth) | Notes |
|---|---|---|:--:|:--:|---|---|
| **Todoist** | Task/To-do | `CB_TODOIST_API_TOKEN` (+login email/pw) | 🟢 | ✅ | `GET api.todoist.com/api/v1/projects` (Bearer) | login.sh exists; v2/sync are 410 → use api/v1 |
| **Trello** | Task/Kanban | `CB_TRELLO_API_KEY` `CB_TRELLO_TOKEN` | 🟢 | ✅ | `GET api.trello.com/1/members/me?key=&token=` | Atlassian MFA email code; key via Power-Up |
| **Baserow** | Spreadsheet/DB (OSS) | `CB_BASEROW_API_TOKEN` | 🟢 | ✅ | `GET api.baserow.io/api/database/tokens/check/` (Token) | non-expiring DB token |
| **NocoDB** | Spreadsheet/DB (OSS) | `CB_NOCODB_API_TOKEN` | 🟢 | ✅ | `GET app.nocodb.com/api/v2/meta/workspaces/` (xc-token) | API is workspace-scoped (ws `wnrusqvf`) |
| **Teable** | Spreadsheet/DB (OSS) | `CB_TEABLE_API_TOKEN` | 🟢 | ✅ | `GET app.teable.io/api/auth/user` (Bearer) | PAT needs "Add all resources" for base data |
| **Grist** | Spreadsheet/DB (OSS) | `CB_GRIST_API_KEY` | 🟢 | ✅ | `GET docs.getgrist.com/api/orgs` (Bearer) | key in masked input → char-code read |
| **Shortcut** | Task/Issue | `CB_SHORTCUT_API_TOKEN` | 🟢 | ✅ | `GET api.app.shortcut.com/api/v3/member` (Shortcut-Token) | token is Read-only; make Full-access for writes |
| **SeaTable** | Spreadsheet/DB (OSS) | `CB_SEATABLE_API_TOKEN` (+login email/pw) | 🟢 | ✅ | `GET cloud.seatable.io/api2/account/info/` (Token) | account token → per-base tokens for data |
| **Coda** | Doc/Database | `CB_CODA_API_TOKEN` (+login email) | 🟢 | 👤 | `GET coda.io/apis/v1/whoami` (Bearer) | reCAPTCHA on signup (one human click) |
| **Gong** | Revenue intelligence | `CB_GONG_ACCESS_KEY` `CB_GONG_ACCESS_KEY_SECRET` `CB_GONG_API_BASE_URL` | 🟡 | ⛔ | `GET <base>/v2/workspaces` (Basic: key:secret) | partner **developer instance** (form at collective.gong.io, ~5 business days — no self-serve); login is Google SSO only → **API-only**, no login.sh; instance-specific base URL (us02-125032) |

_All nine re-validated HTTP 200 on 2026-06-26. Provisioning runs: [`provisioning-runs/`](./provisioning-runs/)._
