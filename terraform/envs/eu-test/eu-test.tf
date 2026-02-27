module "eu_test" {
  source = "../../modules/env"

  env_name           = "eu-test"
  app_env            = "test"
  gcp_project_id     = "spv1eu-test"
  gcp_project_number = 491293505063
  gcp_region         = "europe-west1"
  gcp_zone           = "europe-west1-b"
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
  enable_scratch_git                  = true
  scratch_git_boot_disk_size_gb       = 30
  scratch_git_snapshot_hours_in_cycle = 12
  scratch_git_disk_size_gb            = 50

  # Services
  force_reload_services          = var.force_reload_services
  api_service_min_instance_count = 2
  api_service_max_instance_count = 2
  worker_concurrency             = 10
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
