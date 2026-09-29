resource "google_compute_router" "router" {
  project = var.gcp_project_id
  name    = "nat-router"
  network = var.vpc_network_name
  region  = var.gcp_region
}

resource "google_compute_address" "nat_egress" {
  name         = "nat-egress-ip"
  region       = var.gcp_region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"
  project      = var.gcp_project_id

  description = "Static IP for Cloud NAT egress - customers can whitelist this IP"
}

resource "google_compute_router_nat" "nat" {
  name                               = "my-router-nat"
  router                             = google_compute_router.router.name
  region                             = var.gcp_region
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.nat_egress.self_link]
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  # Ports cap concurrent connections per instance to one destination ip:port, and a closed
  # connection holds its port for TIME_WAIT. The default 64 ports / 120s ran out (DEV-12034).
  # Every endpoint reserves min_ports_per_vm from the single allowlisted IP's 64,512 ports.
  min_ports_per_vm                    = 2048
  enable_dynamic_port_allocation      = false
  enable_endpoint_independent_mapping = false
  tcp_time_wait_timeout_sec           = 60

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}