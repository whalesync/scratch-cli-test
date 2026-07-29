## ---------------------------------------------------------------------------------------------------------------------
## Cloud Run Load Balancer
## This module creates a global HTTPS load balancer for a Cloud Run service
## ---------------------------------------------------------------------------------------------------------------------

# Reserve a static IP address for the load balancer
resource "google_compute_global_address" "default" {
  name = "${var.name}-lb-ip"
}

# Create a serverless NEG for the Cloud Run service
resource "google_compute_region_network_endpoint_group" "cloudrun_neg" {
  name                  = "${var.name}-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region
  cloud_run {
    service = var.cloud_run_service_name
  }
}

# Create backend service
resource "google_compute_backend_service" "default" {
  name = "${var.name}-backend"

  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTP"
  port_name             = "http"
  session_affinity      = var.session_affinity

  # Security headers added to every response
  custom_response_headers = var.custom_response_headers

  backend {
    group = google_compute_region_network_endpoint_group.cloudrun_neg.id
  }

  # Enable Cloud CDN if requested
  dynamic "cdn_policy" {
    for_each = var.enable_cdn ? [1] : []
    content {
      cache_mode                   = "CACHE_ALL_STATIC"
      default_ttl                  = 3600
      client_ttl                   = 7200
      max_ttl                      = 86400
      negative_caching             = true
      serve_while_stale            = 86400
      signed_url_cache_max_age_sec = 0

      cache_key_policy {
        include_host         = true
        include_protocol     = true
        include_query_string = true
      }
    }
  }

  # Enable logging
  log_config {
    enable      = true
    sample_rate = var.log_sample_rate
  }
}

# Create Google-managed SSL certificate
resource "google_compute_managed_ssl_certificate" "default" {
  name = "${var.name}-ssl-cert"

  managed {
    domains = var.domains
  }

  lifecycle {
    create_before_destroy = true
  }
}

# Create URL map for HTTPS
resource "google_compute_url_map" "default" {
  name            = "${var.name}-url-map"
  default_service = google_compute_backend_service.default.id
}

# Enforce TLS 1.2+ (disable deprecated TLS 1.0/1.1) — DEV-11003 / pentest SCR-008
resource "google_compute_ssl_policy" "default" {
  name            = "${var.name}-ssl-policy"
  profile         = "MODERN"
  min_tls_version = "TLS_1_2"
}

# Create target HTTPS proxy
resource "google_compute_target_https_proxy" "default" {
  name             = "${var.name}-https-proxy"
  url_map          = google_compute_url_map.default.id
  ssl_certificates = [google_compute_managed_ssl_certificate.default.id]
  ssl_policy       = google_compute_ssl_policy.default.id
}

# Create global forwarding rule for HTTPS
resource "google_compute_global_forwarding_rule" "https" {
  name                  = "${var.name}-https-forwarding-rule"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "443"
  target                = google_compute_target_https_proxy.default.id
  ip_address            = google_compute_global_address.default.id
}

# Create URL map for HTTP to HTTPS redirect
resource "google_compute_url_map" "http_redirect" {
  count = var.enable_http_redirect ? 1 : 0
  name  = "${var.name}-http-redirect"

  default_url_redirect {
    https_redirect         = true
    redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
    strip_query            = false
  }
}

# Create target HTTP proxy for redirect
resource "google_compute_target_http_proxy" "http_redirect" {
  count   = var.enable_http_redirect ? 1 : 0
  name    = "${var.name}-http-proxy"
  url_map = google_compute_url_map.http_redirect[0].id
}

# Create global forwarding rule for HTTP redirect
resource "google_compute_global_forwarding_rule" "http" {
  count                 = var.enable_http_redirect ? 1 : 0
  name                  = "${var.name}-http-forwarding-rule"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  ip_protocol           = "TCP"
  port_range            = "80"
  target                = google_compute_target_http_proxy.http_redirect[0].id
  ip_address            = google_compute_global_address.default.id
}
