module "test" {
  source = "../../modules/env"

  env_name           = "test"
  gcp_project_id     = "spv1-test"
  gcp_project_number = 211553068097
  gcp_region         = "us-central1"
  gcp_zone           = "us-central1-c"
  as_gitlab          = var.as_gitlab

  # Cloud IDS.
  enable_intrusion_detection = false

  # Load Balancer
  enable_client_load_balancer = true
  client_domain               = "test.scratch.md"
  enable_client_cdn           = true
  api_domain                  = "test-api.scratch.md"

  # Database
  db_disk_size         = 10
  db_high_availability = false

  # Monitoring
  enable_alerts                  = true
  enable_email_notifications     = true
  enable_pagerduty_notifications = false

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
