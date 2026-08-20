# Cloud Audit Logs.
#
# Admin Activity logs (config create/update/delete + every SetIamPolicy) are always on, free, and kept
# ~400 days in the immutable _Required bucket, so configuration-change logging already exists in every
# project and has no log_type to "enable" (Oneleet DEV-10978 — "log configuration changes"). This
# resource makes the audit posture explicit in code (drift-protected, provable to an auditor) and adds
# ADMIN_READ (config/metadata reads, off by default). Applied in every environment for parity — and so
# eu-test validates the project-SetIamPolicy apply before eu-production; ADMIN_READ is free everywhere.
# Scoped Data Access logging (DATA_READ/DATA_WRITE for the data-bearing services) is added separately
# below for Oneleet WSG-008 / DEV-10989.
resource "google_project_iam_audit_config" "audit" {
  project = var.gcp_project_id
  service = "allServices"

  audit_log_config {
    log_type = "ADMIN_READ"
  }
}

# Data Access audit logs (Oneleet WSG-008 / DEV-10989 — "who read a secret / wrote a storage object").
# Off by default in GCP, so without this an incident can't authoritatively scope whether secrets or user
# data were accessed. Scoped to data-bearing services only — NOT allServices — to keep Cloud Logging
# ingestion cost near zero. Applied in every environment for parity (eu-test validates the SetIamPolicy
# apply first); the scoped set below is ~free in all of them. Scratch's bulk data plane isn't audit-loggable
# anyway: user records live in git on the scratch-git VM and in Cloud SQL (no row-level Data Access logs
# exist), and Redis is the Memorystore wire protocol, not a Google API.
#
# Secret Manager gets full DATA_READ + DATA_WRITE: cheap here (AccessSecretVersion fires only at Cloud Run
# instance startup, then the value is a mounted env var) and high value. This is also how we capture use of
# the app encryption key — on Scratch that is the ENCRYPTION_MASTER_KEY Secret Manager secret, not a Cloud
# KMS / CMEK key, so (unlike Whalesync) there is no cloudkms.googleapis.com to log.
resource "google_project_iam_audit_config" "data_access_full" {
  for_each = toset([
    "secretmanager.googleapis.com",
  ])
  project = var.gcp_project_id
  service = each.key

  audit_log_config {
    log_type = "ADMIN_READ"
  }
  audit_log_config {
    log_type = "DATA_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}

# Cloud Storage gets DATA_WRITE only — the deliberate inverse of Whalesync's DATA_READ-only choice, because
# the cost profiles are inverted. On Scratch the firehose is object READS: the public <proj>-assets /
# <proj>-static buckets are served straight from storage.googleapis.com with the CDN off, so DATA_READ would
# scale with page views AND merely duplicate the GCS bucket access logs already delivered by DEV-10995 /
# WSG-014. DATA_WRITE is bounded (asset rehosting during pulls + per-publish upload-patch PUTs — records
# themselves live in git, not one-object-per-record like Whalesync's synclogs) and is the higher-value
# signal here: who created / overwrote / deleted an object via the API.
resource "google_project_iam_audit_config" "data_access_storage" {
  project = var.gcp_project_id
  service = "storage.googleapis.com"

  audit_log_config {
    log_type = "ADMIN_READ"
  }
  audit_log_config {
    log_type = "DATA_WRITE"
  }
}
