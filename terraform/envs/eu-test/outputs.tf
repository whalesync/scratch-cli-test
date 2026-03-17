output "cloud_run_environment" {
  value = module.eu_test.cloud_run_environment
}

output "gitlab_oidc_service_account" {
  value = module.eu_test.gitlab_oidc_service_account
}

output "database_url" {
  value     = module.eu_test.database_url
  sensitive = true
}

output "redis_host" {
  value = module.eu_test.redis_host
}

output "redis_password" {
  value     = module.eu_test.redis_password
  sensitive = true
}

output "nat_egress_ip" {
  description = "Static outbound IP for customer whitelisting"
  value       = module.eu_test.nat_egress_ip
}

output "static_assets_lb_ip" {
  description = "IP address of the static assets load balancer"
  value       = module.eu_test.static_assets_lb_ip
}
