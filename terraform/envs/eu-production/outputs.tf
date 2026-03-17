output "cloud_run_environment" {
  value = module.eu_production.cloud_run_environment
}

output "gitlab_oidc_service_account" {
  value = module.eu_production.gitlab_oidc_service_account
}

output "database_url" {
  value     = module.eu_production.database_url
  sensitive = true
}

output "redis_host" {
  value = module.eu_production.redis_host
}

output "redis_password" {
  value     = module.eu_production.redis_password
  sensitive = true
}

output "nat_egress_ip" {
  description = "Static outbound IP for customer whitelisting"
  value       = module.eu_production.nat_egress_ip
}

output "static_assets_lb_ip" {
  description = "IP address of the static assets load balancer"
  value       = module.eu_production.static_assets_lb_ip
}
