# Provisioned connectors — ready for `/connector-build-execute`

Connectors whose **provisioning is finished**: a test account exists, secrets are stored in the shared test-credentials store (Secret Manager, GCP project `whalesync-test-credentials`; each row's secret is the service name in lowercase, e.g. `todoist`, unless its **Test env vars** cell starts with another secret name, e.g. `attio-scratch:`), and the API token has been **validated (HTTP 200)**. Rows provisioned before 2026-10-27 must be imported from the old 1Password note first (see [`test-accounts-mechanism.md`](./test-accounts-mechanism.md#moving-an-account-in-from-the-old-1password-note)). The build step can begin on any of these. Each has a detailed record in [`provisioning-notes/<service>.md`](./provisioning-notes/) (folded into the connector's `STATE.md` and deleted when `/connector-build-execute` starts). Candidates **not yet** here live in [`queued-connectors.md`](/connector-build/queued-connectors.md).

**Gate legend** — **Payment:** 🟢 Free-Tier · 🟡 Trial-NO-CC · 🔴 Trial-CC. **Reg-flow:** ✅ unblocked · ⛔ blocked · 👤 1-off-human-gate (one human CAPTCHA click, then autonomous).

| Service | Type | Test env vars | Pay | Reg | Validated endpoint (auth) | Notes |
|---|---|---|:--:|:--:|---|---|
| **Todoist** | Task/To-do | `TODOIST_API_TOKEN` (+login email/pw) | 🟢 | ✅ | `GET api.todoist.com/api/v1/projects` (Bearer) | login.sh exists; v2/sync are 410 → use api/v1 |
| **Trello** | Task/Kanban | `TRELLO_API_KEY` `TRELLO_TOKEN` | 🟢 | ✅ | `GET api.trello.com/1/members/me?key=&token=` | Atlassian MFA email code; key via Power-Up |
| **Baserow** | Spreadsheet/DB (OSS) | `BASEROW_API_TOKEN` | 🟢 | ✅ | `GET api.baserow.io/api/database/tokens/check/` (Token) | non-expiring DB token |
| **NocoDB** | Spreadsheet/DB (OSS) | `NOCODB_API_TOKEN` | 🟢 | ✅ | `GET app.nocodb.com/api/v2/meta/workspaces/` (xc-token) | API is workspace-scoped (ws `wnrusqvf`) |
| **Teable** | Spreadsheet/DB (OSS) | `TEABLE_API_TOKEN` | 🟢 | ✅ | `GET app.teable.io/api/auth/user` (Bearer) | PAT needs "Add all resources" for base data |
| **Grist** | Spreadsheet/DB (OSS) | `GRIST_API_KEY` | 🟢 | ✅ | `GET docs.getgrist.com/api/orgs` (Bearer) | key in masked input → char-code read |
| **Shortcut** | Task/Issue | `SHORTCUT_API_TOKEN` | 🟢 | ✅ | `GET api.app.shortcut.com/api/v3/member` (Shortcut-Token) | token is Read-only; make Full-access for writes |
| **SeaTable** | Spreadsheet/DB (OSS) | `SEATABLE_API_TOKEN` (+login email/pw) | 🟢 | ✅ | `GET cloud.seatable.io/api2/account/info/` (Token) | account token → per-base tokens for data |
| **Coda** | Doc/Database | `CODA_API_TOKEN` (+login email) | 🟢 | 👤 | `GET coda.io/apis/v1/whoami` (Bearer) | reCAPTCHA on signup (one human click) |
| **Gong** | Revenue intelligence | `GONG_ACCESS_KEY` `GONG_ACCESS_KEY_SECRET` `GONG_API_BASE_URL` | 🟡 | ⛔ | `GET <base>/v2/workspaces` (Basic: key:secret) | partner **developer instance** (form at collective.gong.io, ~5 business days — no self-serve); login is Google SSO only → **API-only**, no login.sh; instance-specific base URL (us02-125032) |

_All nine re-validated HTTP 200 on 2026-06-26. Provisioning runs: [`provisioning-runs/`](./provisioning-runs/)._
