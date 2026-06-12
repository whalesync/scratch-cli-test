locals {
  # Read the list of secrets from secrets.txt in the terraform directory.
  required_secrets = toset(compact(
    [
      for line in split("\n", file("${path.module}/../../secrets.txt")) :
      trimspace(line)
      if !startswith(line, "#")
    ]
  ))
}

# This output exists only for importing the existing secrets in each deploy. We can delete it after importing.
output "secrets" {
  value = local.required_secrets
}

# Manage all required secrets in Terraform, but not their values.
resource "google_secret_manager_secret" "required" {
  for_each  = local.required_secrets
  secret_id = each.key

  replication {
    auto {}
  }
}

# Memorystore Redis instances generate and expose an auth string internally,
# so write it to a secret version automatically.
resource "google_secret_manager_secret_version" "REDIS_PASSWORD" {
  secret      = google_secret_manager_secret.required["REDIS_PASSWORD"].id
  secret_data = module.redis.password
}

# Store the primary Cloud SQL instance's private IP as a secret so connect_to_gcp_db_readonly.sh can read the DB host
# WITHOUT the Cloud SQL Admin API (`gcloud sql instances list`). That API call's quota/consumer project is the calling
# principal's home project, which for the read-only SA is the bare identity project wsv1-dev-identity — it has no Cloud
# SQL Admin API, so the discovery call returns SERVICE_DISABLED. Sourcing the host from a secret (as whalesync does)
# removes that dependency entirely.
resource "google_secret_manager_secret_version" "DB_HOST" {
  secret      = google_secret_manager_secret.required["DB_HOST"].id
  secret_data = local.db_hostname
}

# Secret values accessed from Terraform:
# The following data resources pull in the values for secrets to pass to other resources.
# All access to secrets should be done here so we can manage them in one place.

data "google_secret_manager_secret_version" "pagerduty_integration_key" {
  count  = var.enable_pagerduty_notifications ? 1 : 0
  secret = "PAGERDUTY_INTEGRATION_KEY"
}

# Read-only DB inspection (terraform/tools/connect_to_gcp_db_readonly.sh) reads exactly TWO secrets: the SELECT-only
# "readonly" Postgres user's password and the DB host (private IP). (The script hardcodes the user "readonly" and
# database "scratchpad", so no DB_NAME / user secrets are needed.) Grant role_readonly_sa@ secretAccessor on ONLY these
# two — never project-wide — so a leaked <alias>-readonly key still cannot read any other secret payload.
# `moved`: this was a single resource (READONLY_DB_PASSWORD only) before DB_HOST was added; map the already-applied
# member into the for_each key so re-apply is a state move, not a destroy/recreate of the live grant.
moved {
  from = google_secret_manager_secret_iam_member.readonly_sa_db_password
  to   = google_secret_manager_secret_iam_member.readonly_sa_db_secrets["READONLY_DB_PASSWORD"]
}
resource "google_secret_manager_secret_iam_member" "readonly_sa_db_secrets" {
  for_each  = toset(["READONLY_DB_PASSWORD", "DB_HOST"])
  project   = var.gcp_project_id
  secret_id = google_secret_manager_secret.required[each.key].secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "group:role_readonly_sa@whalesync.com"
}

# TEST ONLY (var.grant_readonly_sa_all_secrets): give role_readonly_sa@ read access to EVERY secret payload in this env
# so developers/agents can run the Scratch server locally against it. Project-wide, so it is a superset of the
# READONLY_DB_PASSWORD grant above. Safe ONLY while this env's secrets are test-scoped and distinct from production —
# never enable in production, where that per-secret DB grant is the ONLY secret access. NB: this hands the read-only SA
# the test env's write-capable creds (DATABASE_URL / MIGRATIONS_DB_*, SCRATCH_ADMIN_API_KEY) and ENCRYPTION_MASTER_KEY,
# so "read-only" still holds on the GCP IAM plane but NOT within the test app/DB; and any secret shared with prod (some
# connector OAuth client secrets, AI API keys) is effectively exposed. Keep those test values throwaway/test-scoped.
resource "google_project_iam_member" "readonly_sa_all_secrets" {
  count   = var.grant_readonly_sa_all_secrets ? 1 : 0
  project = var.gcp_project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "group:role_readonly_sa@whalesync.com"
}
