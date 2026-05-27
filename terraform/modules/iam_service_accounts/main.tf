locals {
  service_account_roles = flatten([for serviceaccount in var.service_accounts : [
    for role in serviceaccount.roles : {
      serviceaccount = serviceaccount.name
      role           = role
    }
  ]])
}

resource "google_service_account" "service_accounts" {
  for_each     = { for serviceaccount in var.service_accounts : serviceaccount.name => serviceaccount }
  project      = var.gcp_project_id
  account_id   = each.value.account_id
  display_name = title(each.value.name)
  description  = try(each.value.description, format("Service Account for %s", title(each.value.name)))
}

resource "google_service_account_iam_binding" "workload_identity" {
  for_each           = { for serviceaccount in var.service_accounts : serviceaccount.name => serviceaccount if serviceaccount.workload_identity != null }
  service_account_id = google_service_account.service_accounts[each.value.name].id
  role               = "roles/iam.workloadIdentityUser"

  members = concat(
    [for pair in setproduct(each.value.workload_identity.workload_identity_project_ids, each.value.workload_identity.workload_identity_namespaces) : format("serviceAccount:%s.svc.id.goog[%s/%s]", pair[0], pair[1], each.value.name)]
  )
}

resource "google_service_account_iam_binding" "service_account_user" {
  for_each           = { for serviceaccount in var.service_accounts : serviceaccount.name => serviceaccount if serviceaccount.service_account_users != [] }
  service_account_id = google_service_account.service_accounts[each.value.name].id
  role               = "roles/iam.serviceAccountUser"

  members = each.value.service_account_users
}

resource "google_service_account_iam_binding" "service_account_token_creator" {
  for_each           = { for serviceaccount in var.service_accounts : serviceaccount.name => serviceaccount if serviceaccount.service_account_users != [] }
  service_account_id = google_service_account.service_accounts[each.value.name].id
  role               = "roles/iam.serviceAccountTokenCreator"

  members = concat(
    each.value.service_account_users,
    each.value.service_account_token_creators,
    [google_service_account.service_accounts[each.value.name].member],
  )
}

# Add the required roles to the SA
resource "google_project_iam_member" "roles" {
  count    = length(local.service_account_roles)
  provider = google-beta
  project  = var.gcp_project_id

  member = google_service_account.service_accounts[local.service_account_roles[count.index].serviceaccount].member
  role   = local.service_account_roles[count.index].role
}
