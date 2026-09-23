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

  # Alert on a spike in configuration changes — Admin Activity audit-log entries (Oneleet DEV-10978).
  # Threshold is tunable; keep it above a normal deploy / terraform-apply burst (config_change_alert_threshold).
  enable_config_change_alerts = true

  # Alert on a spike in Secret Manager accesses — Data Access audit-log entries (Oneleet WSG-008 /
  # DEV-10989). Gross-volume signal (all principals); threshold is tunable (secret_access_alert_threshold,
  # default 500 ≈ 2x the full-fleet deploy peak). Also enabled in eu-test.
  enable_secret_access_alerts = true

  # Alert when a principal NOT on the allowlist (the app SA + GitLab deploy SA) reads a secret — a leaked human
  # credential or rogue SA, caught even at low volume (DEV-10989 follow-up). Prod-only: eu-test's routine
  # readonly-SA/dev secret reads are non-allowlisted principals that would make it noisy.
  enable_secret_access_unexpected_principal_alert = true

  # Alert when a per-dev read-only SA (<alias>-readonly@wsv1-dev-identity...) reads secrets at abnormal VOLUME — a
  # compromised read-only key. Those SAs are excluded from the unexpected-principal alert above and are volume-watched
  # here (secret_access_readonly_sa_threshold, default 200 / 10-min, per principal). Prod-only.
  enable_secret_access_readonly_sa_alert = true

  # Warn when month-to-date Cloud Logging ingestion exceeds log_ingestion_alert_threshold_gib (default
  # 300 GiB) — a cost guardrail on the audit-log volume added by WSG-008 / DEV-10989. Resets monthly.
  enable_log_ingestion_alerts = true

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

  # Download-link health (DEV-11324): uptime checks + warn-tier alerts on the desktop/CLI download endpoints and the
  # public GitHub release source. Prod only — test publishes the -test channel hourly and would be noisy.
  enable_desktop_release_monitoring = true
  enable_github_release_monitoring  = true

  # Artifact Registry cleanup (DEV-11811).
  artifact_registry_cleanup_policy_dry_run          = false
  artifact_registry_keep_most_recent_versions_count = 10
  artifact_registry_delete_versions_older_than_days = 14

  # Database
  # DEV-11820: prod needs >=2 vCPU — at 1 vCPU a single heavy query starves the DB.
  db_tier = "db-custom-2-8192"

  # Scratch Git
  enable_scratch_git            = true
  scratch_git_machine_type      = "e2-highmem-4" # 4 vCPUs, 2 cores, 32 GB memory
  scratch_git_boot_disk_size_gb = 30
  # Snapshot cost right-size (DEV-11823): 4h cadence, 7-day retention
  scratch_git_snapshot_hours_in_cycle = 4
  scratch_git_snapshot_retention_days = 7
  # Disk right-size (DEV-11823 MR2, prod leg): 2000 GB pd-ssd -> 200 GB pd-balanced
  scratch_git_disk_size_gb = 200
  scratch_git_disk_type    = "pd-balanced"
  # Restored-from snapshot (DEV-11823). Do NOT remove: `snapshot` is ForceNew, so clearing it
  # destroys+recreates the disk EMPTY. Keep the referenced snapshot retained.
  scratch_git_disk_source_snapshot = "projects/spv1eu-production/global/snapshots/scratch-git-data-shrunk-202609221539"
  # Restoring a populated snapshot, not formatting a blank disk.
  scratch_git_initialize_filesystem = false

  # Services
  # Cost right-size (DEV-11812): drop the pinned min=2 to a single always-on instance
  # per service while keeping max headroom for bursts; client/api memory trimmed via module defaults.
  # Worker memory raised to 3Gi — 2Gi OOM'd on large sync/publish jobs (DEV-11820).
  force_reload_services             = var.force_reload_services
  maintenance_mode_enabled          = var.maintenance_mode_enabled
  api_service_min_instance_count    = 1
  api_service_max_instance_count    = 2
  client_service_min_instance_count = 1
  worker_service_min_instance_count = 1
  worker_service_max_instance_count = 2
  worker_service_memory_limit       = "3Gi"
  worker_service_node_options       = "--max-old-space-size=2560"
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
