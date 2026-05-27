variable "gcp_project_id" {
  description = "What project should this service account be created in."
  type        = string
}

variable "service_accounts" {
  description = "List of serviceaccounts to be created with optional workload identity"
  type = list(object({
    name                  = string
    account_id            = string
    description           = optional(string, null)
    service_account_users          = optional(list(string), [])
    service_account_token_creators = optional(list(string), [])
    workload_identity = optional(object({
      workload_identity_project_ids = list(string)
    workload_identity_namespaces = list(string) }), null)
    roles = optional(list(string), [])
  }))
}
