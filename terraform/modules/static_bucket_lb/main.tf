## ---------------------------------------------------------------------------------------------------------------------
## Static Assets Bucket with HTTPS Load Balancer
## Creates a GCS bucket fronted by an HTTPS load balancer with a custom domain and managed SSL certificate.
## ---------------------------------------------------------------------------------------------------------------------

## ---------------------------------------------------------------------------------------------------------------------
## GCS Bucket
## ---------------------------------------------------------------------------------------------------------------------

resource "google_storage_bucket" "static" {
  name          = "${var.gcp_project_id}-static"
  location      = var.bucket_location
  force_destroy = false

  uniform_bucket_level_access = true

  cors {
    method          = ["GET"]
    origin          = var.cors_origins
    response_header = ["Content-Type"]
    max_age_seconds = 3600
  }

  labels = {
    "vanta-contains-user-data" = "false"
  }
}

## ---------------------------------------------------------------------------------------------------------------------
## IAM — Public read access (objects only, no listing)
## ---------------------------------------------------------------------------------------------------------------------

resource "google_project_iam_custom_role" "static_object_reader" {
  role_id     = "staticObjectReader"
  title       = "Static Object Reader"
  description = "Allows reading individual objects but not listing bucket contents"
  permissions = ["storage.objects.get"]
}

resource "google_storage_bucket_iam_member" "public_read" {
  bucket = google_storage_bucket.static.name
  role   = "projects/${var.gcp_project_id}/roles/${google_project_iam_custom_role.static_object_reader.role_id}"
  member = "allUsers"
}

## ---------------------------------------------------------------------------------------------------------------------
## Backend Bucket
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_backend_bucket" "static" {
  name        = "${var.name}-backend-bucket"
  bucket_name = google_storage_bucket.static.name
  enable_cdn  = false

  custom_response_headers = [
    "Cache-Control: public, max-age=31536000, immutable"
  ]
}

## ---------------------------------------------------------------------------------------------------------------------
## Static IP + SSL Certificate
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_global_address" "static" {
  name = "${var.name}-lb-ip"
}

resource "google_compute_managed_ssl_certificate" "static" {
  name = "${var.name}-ssl-cert"

  managed {
    domains = [var.domain]
  }

  lifecycle {
    create_before_destroy = true
  }
}

## ---------------------------------------------------------------------------------------------------------------------
## HTTPS Forwarding
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_url_map" "static" {
  name            = "${var.name}-url-map"
  default_service = google_compute_backend_bucket.static.id
}

resource "google_compute_target_https_proxy" "static" {
  name             = "${var.name}-https-proxy"
  url_map          = google_compute_url_map.static.id
  ssl_certificates = [google_compute_managed_ssl_certificate.static.id]
}

resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${var.name}-https-forwarding-rule"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "443"
  target                = google_compute_target_https_proxy.static.id
  ip_address            = google_compute_global_address.static.id
}

## ---------------------------------------------------------------------------------------------------------------------
## HTTP-to-HTTPS Redirect
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_url_map" "http_redirect" {
  name = "${var.name}-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

resource "google_compute_target_http_proxy" "http_redirect" {
  name    = "${var.name}-http-proxy"
  url_map = google_compute_url_map.http_redirect.id
}

resource "google_compute_global_forwarding_rule" "http" {
  name                  = "${var.name}-http-forwarding-rule"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "80"
  target                = google_compute_target_http_proxy.http_redirect.id
  ip_address            = google_compute_global_address.static.id
}
