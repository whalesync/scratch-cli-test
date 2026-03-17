# Output a map of environment variables for each service to show better plan diffs.
output "cloud_run_environment" {
  value = {
    for service in [
      google_cloud_run_v2_service.client_service,
      google_cloud_run_v2_service.api_service,
    ] :
    service.name => {
      for env in service.template[0].containers[0].env[*] :
      env.name => length(env.value_source) == 0 ?
      env.value :
      "secretKeyRef:${try(env.value_source[0].secret_key_ref[0].secret, "ERROR")}:${try(env.value_source[0].secret_key_ref[0].version, "ERROR")}"
    }
  }
}

output "gitlab_oidc_service_account" {
  value = module.gl_oidc.oidc_service_account_email
}

output "database_url" {
  value     = "postgresql://postgres:${urlencode(module.db_primary.root_password)}@${module.db_primary.host_ip_address}/scratchpad?sslmode=require"
  sensitive = true
}

output "redis_host" {
  value = module.redis.host
}

output "redis_password" {
  value     = module.redis.password
  sensitive = true
}

output "nat_egress_ip" {
  description = "Static outbound IP for customer whitelisting"
  value       = module.cloudnat.nat_egress_ip
}

output "static_assets_lb_ip" {
  description = "IP address of the static assets load balancer"
  value       = var.enable_static_assets_lb ? module.static_bucket_lb[0].ip_address : null
}
