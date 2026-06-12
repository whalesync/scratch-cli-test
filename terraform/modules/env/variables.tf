variable "env_name" {
  type        = string
  description = "Name of the environment: test | staging | production"
}

variable "default_labels" {
  type        = map(string)
  default     = null
  description = "Override for the default labels applied to all resources. If not set, defaults to {terraform: true, env: env_name}."
}

variable "app_env" {
  type        = string
  default     = null
  description = "Override for APP_ENV. If not set, defaults to env_name. Must be one of: development, test, staging, production, automated_test"
}

variable "gcp_project_id" {
  type        = string
  description = "GCP Project ID where resources are to be deployed"
}

variable "gcp_project_number" {
  type        = number
  description = "The number of the GCP project"
}

variable "gcp_region" {
  type        = string
  description = "Region where cloud resources are to be created."
}

variable "gcp_zone" {
  description = "GCP zone for resources"
  type        = string
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

variable "db_version" {
  type    = string
  default = "POSTGRES_17"
}

variable "db_tier" {
  type = string
  # Format is "db-custom-<NUM VCPUS>-<MEMORY IN MB>"
  default = "db-custom-2-8192"
}

variable "db_disk_size" {
  type        = number
  default     = 10
  description = "The initial size of the disk in GB"
}

variable "db_maintenance_day" {
  type    = number
  default = 7
}

variable "db_maintenance_hour" {
  type    = number
  default = 2
}

variable "db_backup_start_time" {
  type    = string
  default = "03:00"
}

variable "db_connection_limit" {
  type        = number
  default     = 400
  description = "Maximum number of connections to the database."
}

variable "db_io_read_limit" {
  type        = number
  default     = 300
  description = "Maximum number of read IOPS allowed by the CloudSQL database."
}

variable "db_io_write_limit" {
  type        = number
  default     = 300
  description = "Maximum number of write IOPS allowed by the CloudSQL database."
}

variable "db_high_availability" {
  type        = bool
  description = "Whether to enable high availability for the Cloud SQL instance. If enabled, a failover replica is automatically created."
  default     = true
}

variable "redis_memory_size_gb" {
  type        = number
  default     = 1
  description = "Redis memory size in GiB."
}

variable "redis_enable_ha" {
  type        = bool
  default     = false
  description = "Enable Redis High Availability"
}

variable "enable_intrusion_detection" {
  type        = bool
  default     = true
  description = "Whether to enable Cloud IDS. This is expensive so it's only needed in prod environments."
}

variable "intrusion_detection_external_url" {
  type        = string
  default     = null
  description = "External IDS endpoint URL. If set, skips creation of google_cloud_ids_endpoint."
}

variable "enable_alerts" {
  type        = bool
  default     = true
  description = "Whether to enable alerts for the environment."
}

variable "enable_email_notifications" {
  type        = bool
  default     = true
  description = "Whether to enable the email notification channel for alerts."
}

variable "alert_notification_email" {
  type        = string
  default     = "team@whalesync.com"
  description = "Email address to send alerts to."
}

variable "enable_pagerduty_notifications" {
  type        = bool
  default     = false
  description = "Whether to enable the Pager Duty notification channel for alerts."
}

variable "enable_slack_notifications" {
  type        = bool
  default     = false
  description = "Whether to enable the Slack notification channel for alerts."
}

variable "alert_notification_channel" {
  type        = string
  default     = "#feed-gcp-alerts"
  description = "Slack channel to send alerts to."
}

variable "enable_flow_log_monitoring" {
  type        = bool
  default     = false
  description = "Create log-based metrics and alerts on VPC Flow Logs anomalies (replaces Cloud IDS). Metrics are near-free; alerts additionally honor var.enable_alerts."
}

variable "client_service_min_instance_count" {
  type        = number
  default     = 1
  description = "Minimum number of instances for the client service."
}

variable "client_service_max_instance_count" {
  type        = number
  default     = 1
  description = "Maximum number of instances for the client service."
}

variable "client_service_cpu_limit" {
  type        = string
  default     = "1"
  description = "CPU limit for the client service (e.g., '1', '2', '4')."
}

variable "client_service_memory_limit" {
  type        = string
  default     = "2Gi"
  description = "Memory limit for the client service (e.g., '512Mi', '1Gi', '2Gi')."
}

variable "client_service_node_options" {
  type        = string
  default     = ""
  description = "Node.js options for the client service (e.g., '--max-old-space-size=512')."
}

variable "enable_client_load_balancer" {
  type        = bool
  default     = false
  description = "Whether to enable the HTTPS load balancer for the client service."
}

variable "client_domain" {
  type        = string
  description = "Domain name for the client service (e.g., 'app.scratch.md')."
}

variable "enable_client_cdn" {
  type        = bool
  default     = true
  description = "Whether to enable Cloud CDN for the client service load balancer."
}

variable "api_service_min_instance_count" {
  type        = number
  default     = 1
  description = "Minimum number of instances for the api service."
}

variable "api_service_max_instance_count" {
  type        = number
  default     = 1
  description = "Maximum number of instances for the api service."
}

variable "api_service_cpu_limit" {
  type        = string
  default     = "1"
  description = "CPU limit for the api service (e.g., '1', '2', '4')."
}

variable "api_service_memory_limit" {
  type        = string
  default     = "2Gi"
  description = "Memory limit for the api service (e.g., '512Mi', '1Gi', '2Gi')."
}

variable "api_service_node_options" {
  type        = string
  default     = "--max-old-space-size=1900"
  description = "Node.js options for the api service (e.g., '--max-old-space-size=512')."
}

variable "api_domain" {
  type        = string
  description = "Domain name for the api service (e.g., 'api.scratch.md')."
}

variable "cron_service_cpu_limit" {
  type        = string
  default     = "1"
  description = "CPU limit for the cron service (e.g., '1', '2', '4')."
}

variable "cron_service_memory_limit" {
  type        = string
  default     = "2Gi"
  description = "Memory limit for the cron service (e.g., '512Mi', '1Gi', '2Gi')."
}

variable "cron_service_node_options" {
  type        = string
  default     = "--max-old-space-size=1900"
  description = "Node.js options for the cron service (e.g., '--max-old-space-size=512')."
}

variable "worker_service_min_instance_count" {
  type        = number
  default     = 1
  description = "Minimum number of instances for the worker service."
}

variable "worker_service_max_instance_count" {
  type        = number
  default     = 1
  description = "Maximum number of instances for the worker service."
}

variable "worker_service_cpu_limit" {
  type        = string
  default     = "1"
  description = "CPU limit for the worker service (e.g., '1', '2', '4')."
}

variable "worker_service_memory_limit" {
  type        = string
  default     = "2Gi"
  description = "Memory limit for the worker service (e.g., '512Mi', '1Gi', '2Gi')."
}

variable "worker_service_node_options" {
  type        = string
  default     = "--max-old-space-size=1900"
  description = "Node.js options for the worker service (e.g., '--max-old-space-size=512')."
}

variable "worker_concurrency" {
  type        = number
  default     = 5
  description = "Number of jobs each worker instance processes concurrently."
}

variable "enable_scratch_git" {
  type        = bool
  default     = false
  description = "Whether to enable the scratch-git GCE instance."
}

variable "scratch_git_ops_agent_alert_duration" {
  type        = string
  default     = "300s"
  description = "How long the Ops Agent uptime metric must be absent before opening an incident for the scratch-git GCE instance (e.g. \"300s\" for 5 minutes)."
}

variable "scratch_git_machine_type" {
  type        = string
  default     = "e2-medium"
  description = "Machine type for the scratch-git GCE instance."
}

variable "scratch_git_disk_size_gb" {
  type        = number
  default     = 50
  description = "Size of the persistent data disk for the scratch-git GCE instance in GB."
}

variable "scratch_git_boot_disk_size_gb" {
  type        = number
  default     = 30
  description = "Size of the boot disk for the scratch-git GCE instance in GB."
}

variable "scratch_git_snapshot_hours_in_cycle" {
  type        = number
  default     = 4
  description = "Hours between each disk snapshot for the scratch-git data disk (1, 2, 3, 4, 6, 8, 12, or 24)."
}

variable "scratch_git_disk_source_snapshot" {
  type        = string
  default     = null
  description = "Full snapshot self_link to restore the scratch-git data disk from. When set, Terraform will destroy and recreate the disk and VM. Remove after restore is complete."
}

variable "scratch_git_initialize_filesystem" {
  type        = bool
  default     = false
  description = "Whether to format the scratch-git data disk with ext4 if it has no filesystem. Only set to true when provisioning a brand-new instance."
}

variable "enable_static_assets_lb" {
  type        = bool
  default     = false
  description = "Whether to enable the static assets GCS bucket with HTTPS load balancer."
}

variable "static_assets_domain" {
  type        = string
  default     = ""
  description = "Domain name for the static assets load balancer (e.g., 'static.scratch.md')."
}

variable "langsmith_project" {
  type        = string
  description = "LangSmith project name for tracing (e.g., 'scratchmd', 'scratchmd-test')."
}

variable "use_opentelemetry_metrics" {
  type        = bool
  default     = false
  description = "Whether to enable OpenTelemetry metrics collection with the otel-collector sidecar."
}

variable "otel_collector_image" {
  type        = string
  default     = "us-docker.pkg.dev/cloud-ops-agents-artifacts/google-cloud-opentelemetry-collector/otelcol-google:0.138.0"
  description = "Docker image for the OpenTelemetry Collector sidecar container."
}

variable "opentelemetry_collector_cpu_limit" {
  type        = string
  default     = "0.08"
  description = "CPU limit for the OpenTelemetry Collector sidecar container."
}

variable "opentelemetry_collector_memory_limit" {
  type        = string
  default     = "128Mi"
  description = "Memory limit for the OpenTelemetry Collector sidecar container."
}

variable "vanta_contains_user_data" {
  type        = bool
  default     = false
  description = "Whether to apply the 'vanta-contains-user-data' label to resources that store user data. Only needed in production where Vanta monitors."
}

variable "cloudrun_service_account_token_creators" {
  type        = list(string)
  default     = []
  description = "Additional principals granted roles/iam.serviceAccountTokenCreator on the cloudrun service account. Used in non-production environments to allow developers to run the GCS uploads from their local machines."
}

variable "grant_readonly_sa_all_secrets" {
  type        = bool
  default     = false
  description = <<-EOT
    When true, grant role_readonly_sa@ project-wide secretmanager.secretAccessor — read access to ALL secret payloads in
    this env — so developers/agents can run the Scratch server locally against it. Intended for TEST ONLY; NEVER set it
    for production. Safe only while this env's secrets stay test-scoped and distinct from prod: keep the connector OAuth
    client secrets, the AI/observability keys (GEMINI/OPENROUTER/LANGSMITH/POSTHOG/LINEAR), ENCRYPTION_MASTER_KEY, and
    the write-capable DB creds (DATABASE_URL/MIGRATIONS_DB_*) test-scoped. See
    docs/plans/2026-06-11-local-readonly-agent-access-spinner.md.
  EOT
}
