module "eu_production" {
  source = "../../modules/env"

  env_name           = "eu-production"
  app_env            = "production"
  gcp_project_id     = "spv1eu-production"
  gcp_project_number = 75080978117
  gcp_region         = "europe-west1"
  gcp_zone           = "europe-west1-b"
  as_gitlab          = var.as_gitlab
  default_labels = {
    "terraform" : "true"
    "env" : "production"
  }

  # Cloud IDS (creates a new endpoint in europe-west1-b)
  enable_intrusion_detection = true

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
  enable_scratch_git                  = true
  scratch_git_boot_disk_size_gb       = 20
  scratch_git_snapshot_hours_in_cycle = 1
  scratch_git_disk_size_gb            = 50

  # Services
  force_reload_services          = var.force_reload_services
  maintenance_mode_enabled       = var.maintenance_mode_enabled
  api_service_min_instance_count = 4
  api_service_max_instance_count = 4
  worker_concurrency             = 10

  # Static Assets
  enable_static_assets_lb = true
  static_assets_domain    = "static.scratch.md"

  # Vanta compliance
  vanta_contains_user_data = true

  # LangSmith
  langsmith_project = "scratchmd"
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

variable "maintenance_mode_enabled" {
  type        = bool
  default     = false
  description = "When set to true, sets the MAINTENANCE_MODE_ENABLED environment variable on the client Cloud Run service."
}
