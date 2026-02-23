module "production" {
  source = "../../modules/env"

  env_name           = "production"
  gcp_project_id     = "spv1-production"
  gcp_project_number = 806617013435
  gcp_region         = "us-central1"
  gcp_zone           = "us-central1-c"
  as_gitlab          = var.as_gitlab

  # Cloud IDS.
  enable_intrusion_detection = true
  # Use the existing Cloud IDS endpoint from wsv1-production
  intrusion_detection_external_url = "https://www.googleapis.com/compute/v1/projects/ld5863d2646ef8bfb-tp/regions/us-central1/forwardingRules/ids-fr-ids-en-vjgwaprqioazacaa"

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
