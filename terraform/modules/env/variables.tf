variable "env_name" {
  type        = string
  description = "Name of the environment: test | staging | production"
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
  default     = ""
  description = "Node.js options for the api service (e.g., '--max-old-space-size=512')."
}

variable "api_domain" {
  type        = string
  description = "Domain name for the api service (e.g., 'api.scratch.md')."
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
