# Cloud Audit Logs (Oneleet DEV-10978 — "log configuration changes").
# Admin Activity logs (config create/update/delete + every SetIamPolicy) are always on, free, and kept
# ~400 days in the immutable _Required bucket, so configuration-change logging already exists in every
# project and has no log_type to "enable". This resource makes the audit posture explicit in code
# (drift-protected, provable to an auditor) and adds ADMIN_READ (config/metadata reads, off by default).
# Applied in every environment for parity — and so eu-test validates the project-SetIamPolicy apply
# before eu-production; it is free in all of them. Data-access logging (DATA_READ/DATA_WRITE) is
# deliberately left off: high-volume and billable on these data-heavy projects, and not needed to log
# configuration changes.
resource "google_project_iam_audit_config" "audit" {
  project = var.gcp_project_id
  service = "allServices"

  audit_log_config {
    log_type = "ADMIN_READ"
  }
}
