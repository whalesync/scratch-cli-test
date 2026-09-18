## ---------------------------------------------------------------------------------------------------------------------
## Maintenance Mode
## Load-balancer lockdown for the client and api hosts. The lockdown rule's action and the bypass allowlist are
## flipped at runtime, so Terraform ignores them. See docs/ops/runbook-maintenance-mode.md.
## ---------------------------------------------------------------------------------------------------------------------

locals {
  # The maintenance content is served from the public static bucket, so this feature needs that module.
  maintenance_mode_infra_enabled = var.enable_static_assets_lb

  # Cloud Armor can only deny with 403, 404 or 502. 502 is the one the app never returns itself, so the URL maps can
  # rewrite it to a 503 without clobbering real permission or not-found responses.
  maintenance_lockdown_denied_status_code = "502"
  maintenance_served_status_code          = 503

  maintenance_security_policy_self_link = one(google_compute_security_policy.maintenance[*].self_link)

  maintenance_client_custom_error_response = local.maintenance_mode_infra_enabled ? {
    error_service          = google_compute_backend_bucket.maintenance[0].id
    match_response_codes   = [local.maintenance_lockdown_denied_status_code]
    path                   = "/${google_storage_bucket_object.maintenance_page[0].name}"
    override_response_code = local.maintenance_served_status_code
  } : null

  maintenance_api_custom_error_response = local.maintenance_mode_infra_enabled ? {
    error_service          = google_compute_backend_bucket.maintenance[0].id
    match_response_codes   = [local.maintenance_lockdown_denied_status_code]
    path                   = "/${google_storage_bucket_object.maintenance_api_error_body[0].name}"
    override_response_code = local.maintenance_served_status_code
  } : null
}

## ---------------------------------------------------------------------------------------------------------------------
## Cloud Armor policy (attached to the client and api backend services)
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_security_policy" "maintenance" {
  count = local.maintenance_mode_infra_enabled ? 1 : 0

  name        = "${var.env_name}-maintenance"
  description = "Maintenance-mode lockdown for the client and api load balancers"
  type        = "CLOUD_ARMOR"

  # Rules are managed as standalone resources below; the default allow rule is created by the API.
  lifecycle {
    ignore_changes = [rule]
  }
}

# Source IPs that still reach the real backends during a window. The placeholder is an RFC 5737 documentation address
# that never matches real traffic.
resource "google_compute_security_policy_rule" "maintenance_bypass" {
  count = local.maintenance_mode_infra_enabled ? 1 : 0

  security_policy = google_compute_security_policy.maintenance[0].name
  priority        = 100
  action          = "allow"
  description     = "Maintenance bypass allowlist"

  match {
    versioned_expr = "SRC_IPS_V1"
    config {
      src_ip_ranges = ["192.0.2.1/32"]
    }
  }

  lifecycle {
    ignore_changes = [match, description]
  }
}

# Matches all traffic. "allow" at rest; a maintenance window flips it to deny. Replacing this resource resets it to
# "allow" and would silently end a window, so keep its address stable.
resource "google_compute_security_policy_rule" "maintenance_lockdown" {
  count = local.maintenance_mode_infra_enabled ? 1 : 0

  security_policy = google_compute_security_policy.maintenance[0].name
  priority        = 1000
  action          = "allow"
  description     = "Maintenance lockdown"

  match {
    versioned_expr = "SRC_IPS_V1"
    config {
      src_ip_ranges = ["*"]
    }
  }

  lifecycle {
    ignore_changes = [action, description, preview]
  }

  # Cloud Armor rejects any operation on a policy that is still being changed ("not in a ready state"), so everything
  # that touches this policy runs in sequence: bypass rule, this rule, then the backend service attachments.
  depends_on = [google_compute_security_policy_rule.maintenance_bypass]
}

## ---------------------------------------------------------------------------------------------------------------------
## Maintenance content (served by the URL maps' custom error response policies)
## ---------------------------------------------------------------------------------------------------------------------

# A dedicated backend bucket on the shared static bucket: the static site's backend bucket adds an immutable
# one-year Cache-Control header, which must never apply here. Headers set on this resource are not applied to custom
# error responses, so caching is controlled by the objects' own metadata.
resource "google_compute_backend_bucket" "maintenance" {
  count = local.maintenance_mode_infra_enabled ? 1 : 0

  name        = "${var.env_name}-maintenance-backend-bucket"
  bucket_name = module.static_bucket_lb[0].bucket_name
  enable_cdn  = false
}

resource "google_storage_bucket_object" "maintenance_page" {
  count = local.maintenance_mode_infra_enabled ? 1 : 0

  bucket        = module.static_bucket_lb[0].bucket_name
  name          = "maintenance/index.html"
  source        = "${path.module}/files/maintenance/index.html"
  content_type  = "text/html; charset=utf-8"
  cache_control = "no-store"
}

resource "google_storage_bucket_object" "maintenance_api_error_body" {
  count = local.maintenance_mode_infra_enabled ? 1 : 0

  bucket        = module.static_bucket_lb[0].bucket_name
  name          = "maintenance/api.json"
  source        = "${path.module}/files/maintenance/api.json"
  content_type  = "application/json; charset=utf-8"
  cache_control = "no-store"
}
