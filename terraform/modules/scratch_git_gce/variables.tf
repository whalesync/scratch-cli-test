/**
  * Scratch Git Module Variables
*/

## ---------------------------------------------------------------------------------------------------------------------
## Required Variables
## ---------------------------------------------------------------------------------------------------------------------

variable "instance_name" {
  description = "Name of the GCE instance"
  type        = string
}

variable "zone" {
  description = "Zone for the GCE instance"
  type        = string
}

variable "network" {
  description = "VPC network self_link"
  type        = string
}

variable "subnetwork" {
  description = "Subnetwork ID"
  type        = string
}

variable "gcp_project_id" {
  description = "GCP project ID"
  type        = string
}

variable "service_account_email" {
  description = "Email of the service account for the instance"
  type        = string
}

variable "docker_image" {
  description = "Full Artifact Registry URI for the scratch-git Docker image"
  type        = string
}

variable "network_name" {
  description = "VPC network name, used for firewall rule naming"
  type        = string
}

variable "vpc_cidr_ranges" {
  description = "List of VPC CIDR ranges to allow inbound traffic from (CloudRun services and SQL Proxy VM)"
  type        = list(string)
}

variable "region" {
  description = "Region for the static internal IP address"
  type        = string
}

## ---------------------------------------------------------------------------------------------------------------------
## Optional Variables
## ---------------------------------------------------------------------------------------------------------------------

variable "machine_type" {
  description = "Machine type for the GCE instance"
  type        = string
  default     = "e2-medium"
}

variable "disk_size_gb" {
  description = "Size of the persistent data disk in GB"
  type        = number
  default     = 50
}

variable "disk_type" {
  description = "Type of the persistent data disk"
  type        = string
  default     = "pd-ssd"
}

variable "boot_disk_size_gb" {
  description = "Size of the boot disk in GB"
  type        = number
  default     = 30
}

variable "snapshot_schedule_enabled" {
  description = "Whether to enable automated disk snapshot backups"
  type        = bool
  default     = true
}

variable "snapshot_hours_in_cycle" {
  description = "Hours between each snapshot (e.g. 4 = every 4 hours)"
  type        = number
  default     = 4
}

variable "snapshot_start_time" {
  description = "Time in UTC (HH:MM) when the first snapshot of the cycle begins"
  type        = string
  default     = "05:00"
}

variable "snapshot_retention_days" {
  description = "Number of days to retain disk snapshots"
  type        = number
  default     = 14
}

variable "labels" {
  description = "Labels to apply to data disk and snapshots"
  type        = map(string)
  default     = {}
}

variable "disk_source_snapshot" {
  description = "Full snapshot self_link to restore the data disk from. When set, Terraform will destroy and recreate the disk and VM. Remove after restore is complete."
  type        = string
  default     = null
}
