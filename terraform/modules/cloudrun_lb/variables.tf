variable "name" {
  type        = string
  description = "Name prefix for load balancer resources"
}

variable "region" {
  type        = string
  description = "Region where the Cloud Run service is deployed"
}

variable "cloud_run_service_name" {
  type        = string
  description = "Name of the Cloud Run service to load balance"
}

variable "domains" {
  type        = list(string)
  description = "List of domains for the SSL certificate"
}

variable "enable_cdn" {
  type        = bool
  default     = true
  description = "Enable Cloud CDN for static content caching"
}

variable "enable_http_redirect" {
  type        = bool
  default     = true
  description = "Enable HTTP to HTTPS redirect"
}

variable "log_sample_rate" {
  type        = number
  default     = 1.0
  description = "Sample rate for load balancer logs (0.0 to 1.0)"
}


variable "session_affinity" {
  type        = string
  default     = "NONE"
  description = "Session affinity setting for the backend service. Use 'GENERATED_COOKIE' or 'CLIENT_IP' for websocket connections."
}

variable "custom_response_headers" {
  type        = list(string)
  default     = []
  description = "Response headers the load balancer adds to every response, each in 'Header-Name: value' format (e.g. security headers)."
}
