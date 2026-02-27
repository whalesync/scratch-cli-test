locals {
  artifact_registry_url = "${var.gcp_region}-docker.pkg.dev/${var.gcp_project_id}/${var.env_name}-registry"

  # APIs
  enabled_apis = [
    "certificatemanager.googleapis.com",
    "cloudkms.googleapis.com",
    "cloudresourcemanager.googleapis.com",
    "compute.googleapis.com",
    "datamigration.googleapis.com",
    "iap.googleapis.com",
    "identitytoolkit.googleapis.com",
    "ids.googleapis.com",
    "networkmanagement.googleapis.com",
    "redis.googleapis.com",
    "run.googleapis.com",
    "secretmanager.googleapis.com",
    "servicenetworking.googleapis.com",
    "serviceusage.googleapis.com",
    "sqladmin.googleapis.com",
    "sheets.googleapis.com",
    "drive.googleapis.com",
    "aiplatform.googleapis.com"
  ]

  # IAM
  service_accounts = [
    {
      name        = "cloudrun-service-account"
      account_id  = "cloudrun-service-account"
      description = "Cloud Run service account"
      service_account_users = [
        "serviceAccount:${local.gitlab_service_account_name}@${var.gcp_project_id}.iam.gserviceaccount.com"
      ]
      roles = []
    },
    {
      name        = "cloudsql-proxy-service-account"
      account_id  = "cloudsql-proxy-service-account"
      description = "Service account for the GCE VM that serves as the Cloud SQL Auth Proxy bastion host"
      roles = [
        "roles/cloudsql.client"
      ]
    },
    {
      name        = "scratch-git-service-account"
      account_id  = "scratch-git-service-account"
      description = "Service account for the scratch-git GCE instance"
      roles = [
        "roles/artifactregistry.reader",
        "roles/logging.logWriter"
      ]
    },
  ]

  # Name of the the Gitlab service account
  gitlab_service_account_name = "gitlab-service-account"

  # Name of the custom role for the Gitlab service account
  gitlab_custom_role_name = "gitlab_service_account_role"

  # Add roles here to fix missing permissions on Terraform deploy
  # Most areas will need at least an "editor" type role, if not "admin" because Terraform will need the ability to create and update resources.
  terraform_roles = [
    "projects/${var.gcp_project_id}/roles/${local.gitlab_custom_role_name}",
    "roles/artifactregistry.repoAdmin",
    "roles/cloudkms.admin",
    "roles/cloudsql.editor",
    "roles/compute.instanceAdmin.v1",
    "roles/compute.osAdminLogin",
    "roles/compute.loadBalancerAdmin",
    "roles/compute.networkAdmin",
    "roles/compute.securityAdmin",
    "roles/iam.roleViewer",           # This won't allow creating/updating roles, but should help avoid privilege escalation
    "roles/iam.serviceAccountViewer", # This won't allow creating/updating service accounts, but should help avoid privilege escalation
    "roles/iam.workloadIdentityPoolViewer",
    "roles/iap.tunnelResourceAccessor",
    "roles/ids.admin",
    "roles/logging.admin",
    "roles/monitoring.admin",
    "roles/redis.editor",
    "roles/run.developer",
    "roles/secretmanager.admin",
    "roles/serviceusage.serviceUsageAdmin",
    "roles/storage.admin",
  ]

  # DevOps who need admin access to the project and the ability to run terraform deploys locally
  operations_roles = [
    "roles/artifactregistry.admin",
    "roles/browser",
    "roles/cloudkms.admin",
    "roles/cloudsql.admin",
    "roles/compute.admin",
    "roles/errorreporting.admin",
    "roles/iam.roleAdmin",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/iam.workloadIdentityPoolAdmin",
    "roles/iap.admin",
    "roles/redis.admin",
    "roles/resourcemanager.projectIamAdmin",
    "roles/run.admin",
    "roles/securitycenter.adminEditor",
    "roles/vpcaccess.admin",
    "roles/oauthconfig.editor",
    "roles/securitycenter.settingsEditor",
    "roles/aiplatform.expressAdmin",
  ]

  # Developers with mainly read-only access to the project
  developer_roles = [
    "roles/browser",
    "roles/cloudsql.viewer",
    "roles/cloudsql.studioUser",
    "roles/compute.viewer",
    "roles/storage.objectUser",
    "roles/secretmanager.secretAccessor",
    "roles/secretmanager.viewer",
    "roles/iam.serviceAccountUser",
    "roles/redis.viewer",
    "roles/artifactregistry.reader",
    "roles/artifactregistry.reader",
    "roles/run.developer",
    "roles/monitoring.viewer",
    "roles/logging.viewer",
    "roles/vpcaccess.viewer",
    "roles/iam.roleViewer",
    "roles/errorreporting.viewer",
    "roles/oauthconfig.editor",
    "roles/aiplatform.expressUser",
  ]

  # Assignments of roles to users, groups, and service accounts
  # See https://cloud.google.com/iam/docs/overview#concepts_related_identity for what can be used as a principal.
  principals_to_roles = {
    # Groups that are defined and administrated at the organization level (whalesync.com)
    "group:role_operations@whalesync.com" : [local.terraform_roles, local.operations_roles],
    "group:role_developers@whalesync.com" : local.developer_roles,
  }
  principal_role_pairs = flatten([for principal, roles in local.principals_to_roles : [for role in distinct(flatten(roles)) : { principal : principal, role : role }]])

  # VPC
  vpc_network_name = "${var.env_name}-vpc"
  custom_subnetworks = [
    {
      region        = var.gcp_region
      ip_cidr_range = "192.168.0.0/20" # 192.168.0.0 - 192.168.15.255
    },
    {
      region        = var.gcp_region
      ip_cidr_range = "192.168.16.0/20" # 192.168.16.0 - 192.168.31.255
    }
  ]

  # CloudProxy
  proxy_instance_name = "cloudsql-proxy"

  # Redis
  redis_name = "${var.env_name}-redis"

  # CloudSQL
  db_name     = "${var.env_name}-postgres"
  db_hostname = module.db_primary.host_ip_address

}

## ---------------------------------------------------------------------------------------------------------------------
## Required Services
## ---------------------------------------------------------------------------------------------------------------------

resource "google_project_service" "services" {
  for_each           = toset(local.enabled_apis)
  service            = each.key
  disable_on_destroy = false
}

## ---------------------------------------------------------------------------------------------------------------------
## Artifact Registry
## ---------------------------------------------------------------------------------------------------------------------

resource "google_artifact_registry_repository" "default" {
  repository_id          = "${var.env_name}-registry"
  description            = "Scratchpaper ${var.env_name} registry"
  format                 = "DOCKER"
  cleanup_policy_dry_run = true
  location               = var.gcp_region
  docker_config {
    immutable_tags = false
  }
  depends_on = [google_project_service.services]
}

## ---------------------------------------------------------------------------------------------------------------------
## IAM Role Assignments
## ---------------------------------------------------------------------------------------------------------------------

resource "google_project_iam_member" "roles" {
  for_each = {
    for pair in local.principal_role_pairs :
    "${pair.principal}:${pair.role}" => pair
  }
  project    = var.gcp_project_id
  role       = each.value.role
  member     = each.value.principal
  depends_on = [google_project_service.services]
}

## ---------------------------------------------------------------------------------------------------------------------
## IAM Service Account
## ---------------------------------------------------------------------------------------------------------------------

module "iam-sa" {
  source           = "../../modules/iam_service_accounts"
  gcp_project_id   = var.gcp_project_id
  service_accounts = local.service_accounts
  depends_on       = [google_project_service.services, module.gl_oidc]
}

## ---------------------------------------------------------------------------------------------------------------------
## IAM OIDC Permissions
## ---------------------------------------------------------------------------------------------------------------------
module "gl_oidc" {
  source               = "../../modules/gitlab_oidc"
  service_account_name = local.gitlab_service_account_name
  gcp_project_id       = var.gcp_project_id
  gitlab_namespace     = "whalesync"
  gitlab_project_name  = "spinner"
  iam_roles = concat(
    local.terraform_roles,
    ["roles/run.serviceAgent"]
  )
  depends_on = [google_project_service.services, google_project_iam_custom_role.gitlab_tf_service_account_role]
}

## ---------------------------------------------------------------------------------------------------------------------
## VPC
## ---------------------------------------------------------------------------------------------------------------------

module "vpc" {
  source                         = "../../modules/vpc"
  gcp_project_id                 = var.gcp_project_id
  network_name                   = local.vpc_network_name
  enable_private_service_connect = true
  custom_subnetworks             = local.custom_subnetworks
  flow_sampling                  = 1.0
  depends_on                     = [google_project_service.services]
}

## ---------------------------------------------------------------------------------------------------------------------
## Cloud NAT
## ---------------------------------------------------------------------------------------------------------------------

module "cloudnat" {
  source = "../../modules/cloudnat"

  gcp_project_id   = var.gcp_project_id
  vpc_network_name = module.vpc.network_name
  gcp_region       = var.gcp_region
  depends_on       = [module.vpc]
}

## ---------------------------------------------------------------------------------------------------------------------
## SQL PROXY VM
## ---------------------------------------------------------------------------------------------------------------------
module "gce_instance" {
  source = "../../modules/gce"

  instance_name         = local.proxy_instance_name
  machine_type          = "n2-standard-2"
  image                 = "ubuntu-os-cloud/ubuntu-2204-lts"
  zone                  = var.gcp_zone
  network               = module.vpc.network
  subnetwork            = module.vpc.subnets_id[0]
  enable_iap            = true
  service_account_email = module.iam-sa.service_accounts["cloudsql-proxy-service-account"].email
  gcp_project_id        = var.gcp_project_id
  give_external_ip      = true

  metadata_startup_script = <<-EOT
    #!/bin/bash
    # Just make sure the instance is up to date for now
    apt update -y && apt upgrade -y
  EOT

  depends_on = [module.vpc, module.iam-sa]
}

## ---------------------------------------------------------------------------------------------------------------------
## Scratch Git VM
## ---------------------------------------------------------------------------------------------------------------------

module "scratch_git_gce" {
  count  = var.enable_scratch_git ? 1 : 0
  source = "../../modules/scratch_git_gce"

  providers = {
    google           = google
    google.no_labels = google.no_labels
  }

  instance_name           = "scratch-git"
  zone                    = var.gcp_zone
  region                  = var.gcp_region
  network                 = module.vpc.network
  subnetwork              = module.vpc.subnets_id[0]
  gcp_project_id          = var.gcp_project_id
  service_account_email   = module.iam-sa.service_accounts["scratch-git-service-account"].email
  docker_image            = "${local.artifact_registry_url}/spinner-scratch-git:latest"
  network_name            = local.vpc_network_name
  vpc_cidr_ranges         = [for s in local.custom_subnetworks : s.ip_cidr_range]
  boot_disk_size_gb      = var.scratch_git_boot_disk_size_gb
  disk_size_gb           = var.scratch_git_disk_size_gb
  snapshot_hours_in_cycle = var.scratch_git_snapshot_hours_in_cycle

  depends_on = [module.vpc, module.iam-sa]
}

## ---------------------------------------------------------------------------------------------------------------------
## Redis Cache
## ---------------------------------------------------------------------------------------------------------------------
module "redis" {
  source = "../../modules/redis"

  name               = local.redis_name
  memory_size_gb     = var.redis_memory_size_gb
  enable_ha          = var.redis_enable_ha
  private_network_id = module.vpc.network
  primary_zone       = var.gcp_zone
  region             = var.gcp_region
  depends_on         = [module.vpc]

  labels = {
    # Used to help the connect_to_gcp_* scripts to find the right instance automatically
    "primary" = "true"
  }
}

## ---------------------------------------------------------------------------------------------------------------------
## Cloud SQL Databases
## ---------------------------------------------------------------------------------------------------------------------

module "db_primary" {
  source = "../../modules/cloudsql"

  region             = var.gcp_region
  primary_zone       = var.gcp_zone
  name               = local.db_name
  database_version   = var.db_version
  tier               = var.db_tier
  disk_size          = var.db_disk_size
  high_availability  = var.db_high_availability
  private_network_id = module.vpc.network
  password           = random_password.DB_PASS.result

  maintenance_day   = var.db_maintenance_day
  maintenance_hour  = var.db_maintenance_hour
  backup_enabled    = true
  backup_start_time = var.db_backup_start_time
  backup_location   = var.gcp_region

  labels = {
    # Used to help the connect_to_gcp_* scripts to find the right instance automatically
    "primary"   = "true"
    "env"       = var.env_name,
    "terraform" = "true",
  }

  depends_on = [
    module.vpc,
  ]
}

# TODO: Switch to using ephemeral once google_sql_database_instance supports write-only root_password
resource "random_password" "DB_PASS" {
  length = 24
}

resource "google_secret_manager_secret" "DB_PASS" {
  secret_id = "DB_PASS"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "DB_PASS" {
  secret         = google_secret_manager_secret.DB_PASS.id
  secret_data_wo = random_password.DB_PASS.result

  # NOTE: This must be incremented to write a new version of the secret
  secret_data_wo_version = 1
}
