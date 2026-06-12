variable "instance_name" {
  description = "Name of the GCE instance"
  type        = string
}

variable "machine_type" {
  description = "Machine type for the GCE instance"
  type        = string
}

variable "image" {
  description = "OS image for the GCE instance"
  type        = string
}

variable "zone" {
  description = "Zone for the GCE instance"
  type        = string
}

variable "network" {
  description = "Network for the GCE instance"
  type        = string
}

variable "subnetwork" {
  description = "Subnetwork for the GCE instance"
  type        = string
}

variable "give_external_ip" {
  description = "Whether to include an external IP"
  type        = bool
}

variable "enable_iap" {
  description = "Enable IAP access for the GCE instance"
  type        = bool
  default     = false
}

variable "enable_oslogin" {
  description = "Enable OS Login (IAM-based SSH). When true, `gcloud compute ssh` provisions keys via the user's own OS Login profile instead of writing to instance metadata — which lets least-privilege (read-only) principals SSH in without the compute.instances.setMetadata write the metadata path requires."
  type        = bool
  default     = false
}

variable "gcp_project_id" {
  description = "What project should this VM be created in"
  type        = string
}

variable "service_account_email" {
  description = "The email of the service account that this VM should use"
  type        = string
  default     = "project-compute@developer.gserviceaccount.com"
}

variable "metadata_startup_script" {
  description = "The startup script that should be used when starting the VM"
  type        = string
  default     = <<-EOT
    #!/bin/bash
    apt update -y && apt upgrade -y
  EOT
}
