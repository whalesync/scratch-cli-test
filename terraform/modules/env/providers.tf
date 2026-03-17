provider "google" {
  project = var.gcp_project_id

  add_terraform_attribution_label               = true
  terraform_attribution_label_addition_strategy = "PROACTIVE"
  default_labels = local.default_labels

  impersonate_service_account = var.as_gitlab ? "${local.gitlab_service_account_name}@${var.gcp_project_id}.iam.gserviceaccount.com" : null
}


# The same as the provider above, but without default labels set. 
# google_compute_forwarding_rule fails if you set labels on it.
provider "google" {
  alias                           = "no_labels"
  project                         = var.gcp_project_id
  add_terraform_attribution_label = false
  default_labels                  = {}
  impersonate_service_account     = var.as_gitlab ? "${local.gitlab_service_account_name}@${var.gcp_project_id}.iam.gserviceaccount.com" : null
}
