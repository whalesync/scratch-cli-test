output "nat_egress_ip" {
  description = "Static IP address for outbound traffic (for customer whitelisting)"
  value       = google_compute_address.nat_egress.address
}

output "min_ports_per_vm" {
  description = "NAT source ports reserved per endpoint (caps concurrent connections to a single destination ip:port)"
  value       = google_compute_router_nat.nat.min_ports_per_vm
}

output "nat_gateway_name" {
  description = "Name of the Cloud NAT gateway (the nat_gateway monitored resource's gateway_name label)"
  value       = google_compute_router_nat.nat.name
}
