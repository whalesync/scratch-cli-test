module "eu_production" {
  source = "../../modules/env"

  env_name           = "eu-production"
  app_env            = "production"
  gcp_project_id     = "spv1eu-production"
  gcp_project_number = 75080978117
  gcp_region         = "europe-west1"
  gcp_zone           = "europe-west1-b"
  as_gitlab          = var.as_gitlab

  # Cloud IDS - disabled initially for EU (can enable later with EU-region endpoint)
  enable_intrusion_detection = false

  # Load Balancer
  enable_client_load_balancer = true
  client_domain               = "app.scratch.md"
  enable_client_cdn           = true
  api_domain                  = "api.scratch.md"

  # Monitoring
  enable_alerts                  = true
  enable_email_notifications     = true
  enable_pagerduty_notifications = true

  # Scratch Git
  enable_scratch_git = true

  # Services
  force_reload_services = var.force_reload_services
  api_service_min_instance_count = 4
  api_service_max_instance_count = 4
  worker_concurrency    = 10
}

variable "as_gitlab" {
  type        = bool
  default     = false
  description = "Use the GitLab service account to run Terraform"
}

variable "force_reload_services" {
  type        = bool
  default     = false
  description = "When set to true, forces all google_cloud_run_v2_service resources to be reloaded by setting an env var to a randomly generated value."
}
