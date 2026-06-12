module "eu_test" {
  source = "../../modules/env"

  env_name           = "eu-test"
  app_env            = "test"
  gcp_project_id     = "spv1eu-test"
  gcp_project_number = 491293505063
  gcp_region         = "europe-west1"
  gcp_zone           = "europe-west1-b"
  as_gitlab          = var.as_gitlab

  # TEST ONLY: let role_readonly_sa@ read ALL test secret payloads so developers/agents can run the Scratch server
  # locally against test. Test secrets must stay test-scoped + distinct from prod (see the variable's caveat). NEVER set
  # this in eu-production.
  grant_readonly_sa_all_secrets = true

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
  maintenance_mode_enabled       = var.maintenance_mode_enabled
  api_service_min_instance_count = 2
  api_service_max_instance_count = 2
  worker_service_min_instance_count = 2
  worker_service_max_instance_count = 2
  worker_concurrency                = 10


  # Static Assets
  enable_static_assets_lb = true
  static_assets_domain    = "test-static.scratch.md"

  # LangSmith
  langsmith_project = "scratchmd-test"

  # Metrics
  use_opentelemetry_metrics = true

  # Let local Scratch servers mint tokens for the cloudrun SA so they can do GCS uploads: the server impersonates the
  # cloudrun SA (which holds storage.objectAdmin on the asset/upload-patch buckets) for both object writes and V4 signed
  # URLs — see GCS_LOCAL_SIGNING_SA in server/.env.example. role_readonly_sa@ is the laptop's read-only-by-default
  # identity (DEV-10401), so it's the one that needs this for local dev. role_developers@ is kept for any dev not yet on
  # the read-only-SA flow; prune it once the team is fully migrated. (curtis@ was dropped — local dev now runs as
  # curtis-readonly@, a member of role_readonly_sa@.) TEST ONLY — never grant cloudrun-SA impersonation in production.
  cloudrun_service_account_token_creators = [
    "group:role_developers@whalesync.com",
    "group:role_readonly_sa@whalesync.com",
  ]
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
