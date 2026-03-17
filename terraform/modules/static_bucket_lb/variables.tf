variable "name" {
  type        = string
  description = "Name prefix for all resources"
}

variable "gcp_project_id" {
  type        = string
  description = "GCP Project ID"
}

variable "bucket_location" {
  type        = string
  description = "GCS bucket location (region or multi-region)"
}

variable "domain" {
  type        = string
  description = "Domain name for the static assets (e.g., 'static.scratch.md')"
}

variable "cors_origins" {
  type        = list(string)
  default     = []
  description = "Allowed CORS origins for the bucket"
}

variable "log_sample_rate" {
  type        = number
  default     = 1.0
  description = "Sample rate for load balancer logs (0.0 to 1.0)"
}
