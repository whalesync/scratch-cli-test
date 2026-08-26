# Runbook: Managing GCP Secrets

Scratch stores its secure runtime configuration — API keys, OAuth client secrets, database passwords, webhook URLs — as **secrets in GCP Secret Manager**. Each environment keeps its own copy of every secret. At deploy time Cloud Run reads the values and injects them into the containers as environment variables, so application code never sees the raw secret, only the env var.

Two things describe a secret in this repo:

- **The secret container** (its name/ID) is declared in Terraform. The canonical list lives in [`terraform/secrets.txt`](/terraform/secrets.txt) — one secret name per line — and Terraform creates a `google_secret_manager_secret` for each entry in every environment ([`terraform/modules/env/secrets.tf`](/terraform/modules/env/secrets.tf)). Terraform manages the **container only**, never the value.
- **The secret value** is set per environment with `gcloud` and is **never** stored in the repo or in Terraform state.

A secret therefore has a lifecycle: register the container → set a value in each environment → reference it from a Cloud Run service → rotate the value when needed → (eventually) delete it. This runbook covers each step using the helper scripts in [`terraform/tools/`](/terraform/tools/).

---

## Environments

There are two environments, each a distinct GCP project:

| Environment    | GCP project         | Terraform dir                  | Terraform module |
| -------------- | ------------------- | ------------------------------ | ---------------- |
| Test           | `spv1eu-test`       | `terraform/envs/eu-test`       | `eu_test`        |
| Production     | `spv1eu-production` | `terraform/envs/eu-production` | `eu_production`  |

> **Naming gotcha.** `add_secret.sh` and `remove_secret.sh` operate on **both** environments at once and refer to them by their full Terraform names (`eu-test`, `eu-production`). But `update_secret_value.sh` (and `get_secrets.sh` / `check_env_secrets.sh`) take a **short** environment argument — `test` or `production` — which they expand to the project `spv1eu-<env>`. So you update a value with `update_secret_value.sh production …`, not `eu-production`.

---

## Prerequisites

- **An authenticated `gcloud` session** with access to Secret Manager in the target project(s):

  ```bash
  gcloud auth login
  ```

  Every script and Terraform run here authenticates through `gcloud`. If you plan to let the scripts run `terraform apply`, also initialise the env dirs once (`cd terraform/envs/eu-test && terraform init`, same for `eu-production`) and make sure your account can apply — see [`terraform/README.md`](/terraform/README.md).

- **A clean git index.** `add_secret.sh` and `remove_secret.sh` refuse to run if you have staged changes, because they create their own commit. Commit or `git reset` first.

- **Run the scripts from anywhere** — they resolve paths relative to themselves. Examples below assume the repo root.

---

## Add a secret

This registers a new secret **container** in every environment. It does **not** set a value (that's the next section) and does **not** wire it into any service.

1. **Be on a branch.** The script commits the `secrets.txt` change for you, so work on a feature branch (existing or new) rather than `master`:

   ```bash
   git checkout -b add-my-new-secret
   ```

2. **Choose a name.** Use `ALL_CAPS_SNAKE_CASE`, descriptive, and matching the env-var name the app will read (e.g. `STRIPE_WEBHOOK_SECRET`, `WIX_CLIENT_SECRET`). The name becomes both the Secret Manager ID and the Cloud Run env-var name.

3. **Run the script** with the secret name as the only argument:

   ```bash
   ./terraform/tools/add_secret.sh MY_NEW_SECRET_NAME
   ```

   The script will:
   - Fail if the name already exists in `secrets.txt`.
   - Append the name, re-sort and de-dupe the file, show you the diff, then **commit it** (`Added secret MY_NEW_SECRET_NAME`).
   - Prompt: `Do you want to apply this locally with Terraform? [y/N]`. Answer **`y`** to create the empty secret container in both `eu-test` and `eu-production` immediately (a targeted `terraform apply` on `…google_secret_manager_secret.required`). Answer **`N`** to let CI create it when the branch merges.

4. **Push the branch and open a merge request.** The container only stays managed once `secrets.txt` is on `master` — if you applied locally but never merge, a later CI apply from `master` will see the secret missing from `secrets.txt` and **destroy it**. Merge to make the change canonical.

> At this point the secret exists but is **empty**. It is not yet usable by any service.

---

## Update a secret's value

Set or rotate the value in a given environment. This talks directly to GCP — there is **no repo change and nothing to commit**. You must do this **once per environment** before any service references the secret, otherwise the Cloud Run revision that mounts it will fail to deploy (it resolves version `latest`, and an empty secret has none).

Run the script once per environment that needs a value:

```bash
# Args: <environment> <secret_name> <secret_value>   (environment is test | production)
./terraform/tools/update_secret_value.sh test       MY_NEW_SECRET_NAME 'the-value'
./terraform/tools/update_secret_value.sh production  MY_NEW_SECRET_NAME 'the-value'
```

The script will:

- Fail if the name isn't in `secrets.txt` (add it first).
- Print the current value (if any). If the new value equals the current one, it does nothing.
- Prompt `Are you sure you want to update the secret? [y/N]` before adding a **new secret version** (`gcloud secrets versions add`). Old versions are retained but `latest` now points at your value.

> **Handle the value carefully.** You pass the value as a command-line argument and the script echoes the current value to the terminal, so it lands in your shell history and scrollback. Prefix the command with a space (if your shell is configured to skip such lines from history), clear history afterwards, or rotate the secret if you suspect exposure. Never paste a production value into chat, a ticket, or a commit.

To verify what's set across an environment without printing every value, use `./terraform/tools/check_env_secrets.sh <env>` (confirms each secret has an accessible `latest` version); `./terraform/tools/get_secrets.sh <env>` prints `NAME=value` pairs.

> **Rotating a value a service already uses?** Writing a new version is only half the job — running Cloud Run instances keep the old value until they restart. See [**Rotate a live secret**](#rotate-a-live-secret) for the required redeploy step.

---

## Rotate a live secret

Rotating a secret that a Cloud Run service **already** reads is a **two-step** operation. [Updating the value](#update-a-secrets-value) writes a new `latest` version, but the services read secrets only at container start and hold them as `process.env` — there is no in-process Secret Manager client — so **running instances keep the old value until they restart**. A plain `terraform apply` will not restart them either: the env-var list is unchanged, so there is no diff to roll a new revision.

**Step 1 — write the new version** (once per environment you're rotating). For a third-party credential, regenerate it in the provider's console _first_ (see the table below), then:

```bash
./terraform/tools/update_secret_value.sh production SECRET_NAME 'new-value'
```

**Step 2 — force a redeploy** so every service re-reads `latest`. This mints a fresh `FORCE_RELOAD` UUID, which rolls a new revision of all four services (rolling, no extra downtime):

```bash
cd terraform/envs/eu-production && terraform apply -var force_reload_services=true
```

(Use `eu-test` + `update_secret_value.sh test …` for the test environment.) **Until Step 2 runs, the old credential is still live in memory on the running instances** — so for an exposure, both steps are required to actually cut off the old value.

> **Upstream first for third-party secrets.** Rotating only the Secret Manager copy without regenerating the credential at the provider (Clerk, Stripe, a connector OAuth app, …) leaves the old credential valid upstream. Regenerate at the provider, then run Steps 1–2 with the new value.

For the rationale, the schedule, and which secrets we rotate routinely vs. only on exposure, see [`dev-10993-secret-rotation-risk-acceptance.md`](/docs/ops/dev-10993-secret-rotation-risk-acceptance.md).

### Where to regenerate the highest-value secrets

Upstream pointers for the secrets on the manual rotation cadence. Mint the new value at the source, then run Steps 1–2 above.

| Secret                                                                                                                                                                        | Where to regenerate upstream                                                                | Notes                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`, `READONLY_DB_PASSWORD`, `MIGRATIONS_DB_PASSWORD`                                                                                                             | Cloud SQL (Postgres) — `ALTER USER … WITH PASSWORD` for the role, then rebuild the URL       | Coordinate so app and DB agree; the read-only / migrations password can rotate with a brief interruption.                                                                               |
| `DB_PASS`                                                                                                                                                                    | Cloud SQL root password — Terraform-managed via `random_password`                            | Not a plain value swap; a coordinated Terraform + instance operation.                                                                                                                   |
| `REDIS_PASSWORD`                                                                                                                                                             | Memorystore instance AUTH string                                                             | Update the instance AUTH and the secret together.                                                                                                                                       |
| `ENCRYPTION_MASTER_KEY`                                                                                                                                                      | App credential-encryption key — **special**                                                  | **Not** a plain swap: requires a bulk re-encrypt of stored credentials (no rollover window). See the risk-acceptance doc.                                                               |
| `CLERK_SECRET_KEY`                                                                                                                                                           | Clerk dashboard → API keys                                                                    |                                                                                                                                                                                        |
| `STRIPE_API_KEY`                                                                                                                                                            | Stripe dashboard → Developers → API keys (roll the secret key)                               |                                                                                                                                                                                        |
| `STRIPE_WEBHOOK_SECRET`                                                                                                                                                      | Stripe dashboard → Webhooks → signing secret                                                  | Blocked until the app accepts multiple signing secrets.                                                                                                                                 |
| `SENDGRID_API_KEY`                                                                                                                                                          | SendGrid → Settings → API Keys                                                                |                                                                                                                                                                                        |
| `SCRATCH_ADMIN_API_KEY`                                                                                                                                                     | Generate a new random token                                                                   | Shared token that bottlenose sends to Scratch; coordinate the new value with the Whalesync/bottlenose side so both hold it close together (a mismatch fails admin calls). The server also accepts an optional `SCRATCH_ADMIN_API_KEY_PREVIOUS` for a zero-gap overlap, not currently provisioned.                        |
| `SCRATCH_GIT_AUTH_TOKEN`                                                                                                                                                    | Generate a new random token                                                                   | Shared with the scratch-git service; update both sides close together.                                                                                                                  |
| Connector OAuth client secrets (`AIRTABLE_*`, `NOTION_*`, `WEBFLOW_*`, `SHOPIFY_*`, `PIPEDRIVE_*`, `WIX_*`, `ZOHO_*`, `SUPABASE_*`, `GOOGLE_SHEETS_*`, `GOHIGHLEVEL_*`, `QUICKBOOKS_*`, `YOUTUBE_*`, `LINEAR_OAUTH_*`) | Regenerate the client secret in each provider's developer console                            | The `_V2` entries are a second app generation; new connections use the current version (`oauthAppVersion`), existing ones keep refreshing against the app that issued their tokens. Not every provider supports rotation. |
| `POSTHOG_API_KEY`, `POSTHOG_FEATURE_FLAG_API_KEY`                                                                                                                          | PostHog project settings                                                                      |                                                                                                                                                                                        |
| `PAGERDUTY_INTEGRATION_KEY`                                                                                                                                                 | PagerDuty → the service's integration                                                         |                                                                                                                                                                                        |
| `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `LANGSMITH_API_KEY`                                                                                                                 | The respective AI-provider console                                                            |                                                                                                                                                                                        |
| `LINEAR_API_KEY`                                                                                                                                                            | Linear → Settings → API                                                                       |                                                                                                                                                                                        |
| `GITHUB_RELEASES_TOKEN`                                                                                                                                                     | GitHub → personal access tokens                                                               |                                                                                                                                                                                        |
| `SLACK_NOTIFICATION_WEBHOOK_URL`                                                                                                                                            | Slack app → Incoming Webhooks                                                                 |                                                                                                                                                                                        |

---

## Use a secret in a Cloud Run service

**Requirement:** the secret must already exist **and have a value** in the environment you're deploying to (the two sections above). Wiring up a service that references an empty secret will fail the deploy.

Services are defined in [`terraform/modules/env/services.tf`](/terraform/modules/env/services.tf). There are four: `client_service`, `api_service`, `cron_service`, and `worker_service`. Add the secret to the service(s) that actually need it.

**For `api_service`, `cron_service`, `worker_service`** — each has a `dynamic "env"` block commented `# Inject the following secrets into the container as env vars` with a literal list of secret names. Add your secret name to that list (keep it alphabetical to match convention):

```hcl
# Inject the following secrets into the container as env vars
dynamic "env" {
  for_each = [
    "AIRTABLE_CLIENT_ID",
    ...
    "MY_NEW_SECRET_NAME",   # <-- add here
    ...
  ]
  ...
}
```

Each service has its **own** list — adding to `api_service` does not affect `worker_service`. Add the name to every service that reads it.

**For `client_service`** — it has no shared list; secrets are individual `env` blocks (see `CLERK_SECRET_KEY`). Add a matching block:

```hcl
env {
  name = "MY_NEW_SECRET_NAME"
  value_source {
    secret_key_ref {
      secret  = "MY_NEW_SECRET_NAME"
      version = "latest"
    }
  }
}
```

Then **apply Terraform** to roll out a new revision with the env var. The services ignore image changes but not env changes, so this deploys a fresh revision:

```bash
cd terraform/envs/eu-test       && terraform plan && terraform apply
cd terraform/envs/eu-production && terraform plan && terraform apply
```

Commit the `services.tf` change on your branch and merge so CI keeps it deployed. The app can now read the secret from `process.env.MY_NEW_SECRET_NAME`.

---

## Delete a secret

**Requirements — do these first, in order:**

1. **Remove all code references.** Make sure nothing reads `process.env.MY_NEW_SECRET_NAME` anymore.
2. **Remove it from every Cloud Run service** in `services.tf` (the list entry for api/cron/worker, or the `env` block for client) and `terraform apply` each environment so no live revision references it. Nothing in Terraform links the service's `secret_key_ref` string to the secret container, so Terraform will **not** stop you from deleting a still-referenced secret — and a later service deploy would then fail. This ordering is on you.

Once nothing references it, remove the container:

```bash
git checkout -b remove-my-secret      # script commits for you; be on a branch
./terraform/tools/remove_secret.sh MY_NEW_SECRET_NAME
```

The script will:

- Refuse to run with staged changes; fail if the name isn't in `secrets.txt`.
- Remove the line, show the diff, and **commit it** (`Removed secret MY_NEW_SECRET_NAME`).
- Prompt `Do you want to apply this locally with Terraform? [y/N]`. Answering **`y`** runs a targeted `terraform apply` in both environments that **destroys** the secret container (and all its versions) in GCP. Answering **`N`** defers destruction to CI on merge.

Push the branch and open a merge request so `secrets.txt` on `master` reflects the removal.

> **Destruction is permanent.** Removing the container deletes every stored version. If you only meant to rotate the value, use **Update a secret's value** instead. If you're unsure whether anything still depends on it, leave the container in place — an unused empty secret is harmless.

---

## Quick reference

| Task                          | Command                                                              | Repo change? | Touches GCP?               |
| ----------------------------- | ------------------------------------------------------------------- | ------------ | -------------------------- |
| Register a secret container   | `add_secret.sh NAME`                                                 | commits `secrets.txt` | optional targeted apply (both envs) |
| Set an initial value          | `update_secret_value.sh <test\|production> NAME VALUE`               | no           | adds a secret version      |
| Rotate a live secret          | `update_secret_value.sh …` + `terraform apply -var force_reload_services=true` | no | new version + new revision |
| Use in a Cloud Run service    | edit `services.tf` + `terraform apply`                              | commits `services.tf` | deploys new revision  |
| Delete a secret container     | `remove_secret.sh NAME`                                              | commits `secrets.txt` | optional targeted destroy (both envs) |
| Check values exist            | `check_env_secrets.sh <test\|production>`                            | no           | reads only                 |

All scripts live in [`terraform/tools/`](/terraform/tools/) and require an authenticated `gcloud` session.
