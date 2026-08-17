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
  enable_intrusion_detection = false
  enable_flow_log_monitoring = true

  # Load Balancer
  enable_client_load_balancer = true
  client_domain               = "app.scratch.md"
  whalesync_oauth_base_url    = "https://app.whalesync.com"
  enable_client_cdn           = true
  api_domain                  = "api.scratch.md"

  # Whalesync (Dusky) origins allowed to call the Scratch API directly from the browser as a shadow user.
  whalesync_app_origins = ["https://app.whalesync.com"]

  # Monitoring
  enable_alerts                  = true
  enable_email_notifications     = true
  enable_pagerduty_notifications = true
  enable_slack_notifications     = true

  # Scratch Git
  enable_scratch_git                  = true
  scratch_git_machine_type            = "e2-highmem-4" # 4 vCPUs, 2 cores, 32 GB memory
  scratch_git_boot_disk_size_gb       = 30
  scratch_git_snapshot_hours_in_cycle = 1
  scratch_git_disk_size_gb            = 2000

  # Services
  force_reload_services             = var.force_reload_services
  maintenance_mode_enabled          = var.maintenance_mode_enabled
  api_service_min_instance_count    = 2
  api_service_max_instance_count    = 2
  worker_service_min_instance_count = 2
  worker_service_max_instance_count = 2
  worker_concurrency                = 10

  # Static Assets
  enable_static_assets_lb = true
  static_assets_domain    = "static.scratch.md"

  # Vanta compliance
  vanta_contains_user_data = true

  # LangSmith
  langsmith_project = "scratchmd"

  # Metrics
  use_opentelemetry_metrics = true
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

# The bucket holding this very config's Terraform state. Created by hand long before it was managed here; the import
# below adopts it so versioning, access logging, and noncurrent-version cleanup are enforced in code (DEV-10995,
# Oneleet WSG-014).
# The project/name import id form matters: importing by bare name leaves `project` unset in state, which makes the
# explicit project below plan as a forced replacement of the bucket.
import {
  id = "spv1eu-production/spv1eu-production-tfstate"
  to = google_storage_bucket.tfstate
}

resource "google_storage_bucket" "tfstate" {
  name          = "spv1eu-production-tfstate"
  project       = "spv1eu-production"
  location      = "EUROPE-WEST1"
  force_destroy = false

  uniform_bucket_level_access = true

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800 # 7 days
  }

  # Keep noncurrent state versions for 30 days as a rollback window, then delete them.
  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }

  logging {
    log_bucket = module.eu_production.gcs_access_logs_bucket
  }
}
