locals {
  base_labels = var.default_labels != null ? var.default_labels : {
    "terraform" = "true"
    "env"       = var.env_name
  }

  # Governance labels required by Vanta's "gcp-compute-engine-labeled" test (test id gcp-compute-engine-labeled):
  # every GCP Compute Engine instance must carry environment, owner, project, dataclassification, and application
  # labels, all non-empty and lowercase per GCP's label rules. We merge them into the provider-wide default_labels
  # below rather than onto each resource, so they land on every labelable resource in both envs at once — including
  # the two instances the test flags (the scratch-git VM and the cloudsql-proxy bastion) and any future GCE
  # instance — with a single source of truth. This also pre-empts the equivalent labeling checks for other resource
  # types (disks, buckets, Cloud SQL, etc.). See modules/env/providers.tf where default_labels is set on the
  # provider. Refine `application`/`owner` per-resource later if finer attribution is wanted.
  required_governance_labels = {
    "environment"        = coalesce(var.app_env, var.env_name)
    "owner"              = "engineering"
    "project"            = "scratch"
    "dataclassification" = var.vanta_contains_user_data ? "confidential" : "internal"
    "application"        = "scratch"
  }

  default_labels = merge(local.base_labels, local.required_governance_labels)

  artifact_registry_url = "${var.gcp_region}-docker.pkg.dev/${var.gcp_project_id}/${var.env_name}-registry"

  vanta_user_data_labels = var.vanta_contains_user_data ? { "vanta-contains-user-data" = "true" } : {}

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
      service_account_token_creators = var.cloudrun_service_account_token_creators
      roles                          = []
    },
    {
      name        = "cloudsql-proxy-service-account"
      account_id  = "cloudsql-proxy-service-account"
      description = "Service account for the GCE VM that serves as the Cloud SQL Auth Proxy bastion host"
      # role_readonly_sa@ needs actAs on this SA to SSH the bastion via OS Login (read-only DB inspection). OS Login SSH
      # into a VM with an attached SA returns "Permission denied (publickey)" without roles/iam.serviceAccountUser on
      # that SA, even with compute.osLogin granted — this is the exact symptom that got OS Login rolled back on this
      # bastion in 2025 (misread as "OS Login breaks --tunnel-through-iap"). Grant it HERE, through the module's
      # authoritative serviceAccountUser binding, not a standalone google_service_account_iam_member: the authoritative
      # binding would otherwise keep removing the standalone member, thrashing on every apply. NB: the module also
      # confers serviceAccountTokenCreator on this SA to these members; accepted as inert — the SA holds only
      # roles/cloudsql.client (no mutate) and is not an IAM database user.
      service_account_users = ["group:role_readonly_sa@whalesync.com"]
      roles = [
        "roles/cloudsql.client"
      ]
    },
    {
      name        = "scratch-git-service-account"
      account_id  = "scratch-git-service-account"
      description = "Service account for the scratch-git GCE instance"
      # role_readonly_sa@ (the per-dev "gcp-ro" read-only SAs) needs actAs on this SA to SSH the scratch-git VM via OS
      # Login for restricted, read-only inspection (DEV-10366) — exactly as it does for the Cloud SQL bastion above. OS
      # Login SSH into a VM with an attached SA returns "Permission denied (publickey)" without
      # roles/iam.serviceAccountUser on that attached SA, even with compute.osLogin granted. Granted HERE through the
      # module's authoritative serviceAccountUser binding (not a standalone google_service_account_iam_member, which the
      # authoritative binding would keep removing — thrashing every apply). The pairing — instance-scoped compute.osLogin
      # + iap.tunnelResourceAccessor on the scratch-git VM — is in the "Scratch Git VM" section below. NB: the module
      # also confers serviceAccountTokenCreator on this SA to these members; accepted as inert — on-VM access is gated to
      # four read-only `sudo gitops-*` wrappers and the SA itself only reads images/writes logs+metrics.
      service_account_users = ["group:role_readonly_sa@whalesync.com"]
      roles = [
        "roles/artifactregistry.reader",
        "roles/logging.logWriter",
        "roles/monitoring.metricWriter"
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

  # Genuinely read-only roles for the org-level role_readonly_sa@ group — the default local gcloud/ADC identity on a
  # developer laptop (the per-dev "<alias>-readonly" service accounts minted in whalesync DEV-10397, reused here
  # cross-project because both project families live in the same whalesync.com org). Deliberately TIGHTER than
  # developer_roles, which is NOT read-only: that set grants storage.objectUser (object writes), run.developer (deploy),
  # oauthconfig.editor, iam.serviceAccountUser (actAs/impersonation) and cloudsql.studioUser — none of which belong on a
  # long-lived key sitting on a laptop. We omit secretmanager.* entirely so a leaked read-only key cannot read secret
  # payloads. Widen read-only access for every dev at once by adding the missing read role HERE — never a write or
  # escalation role.
  readonly_sa_roles = [
    "roles/browser",
    "roles/cloudsql.viewer",
    "roles/compute.viewer",
    "roles/storage.objectViewer",
    "roles/redis.viewer",
    "roles/artifactregistry.reader",
    "roles/run.viewer",
    "roles/monitoring.viewer",
    "roles/logging.viewer",
    "roles/vpcaccess.viewer",
    "roles/iam.roleViewer",
    "roles/errorreporting.viewer",
    "roles/aiplatform.viewer",
  ]

  # Assignments of roles to users, groups, and service accounts
  # See https://cloud.google.com/iam/docs/overview#concepts_related_identity for what can be used as a principal.
  principals_to_roles = {
    # Groups that are defined and administrated at the organization level (whalesync.com)
    "group:role_operations@whalesync.com" : [local.terraform_roles, local.operations_roles],
    "group:role_developers@whalesync.com" : local.developer_roles,
    # Per-dev "<alias>-readonly" laptop service accounts (members managed in Workspace, not here; SAs minted in whalesync
    # DEV-10397). Read-only by default for laptops + AI agents. Also get restricted, read-only scratch-git VM SSH access
    # (DEV-10366) via the instance-scoped grants in the "Scratch Git VM" section below.
    "group:role_readonly_sa@whalesync.com" : local.readonly_sa_roles,
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

  instance_name = local.proxy_instance_name
  # e2 rather than n2 (mirrors whalesync!8454): same 2 vCPU / 8 GB, ~30% cheaper, and e2 is less exposed to the zonal
  # capacity stockouts that left the stopped wsv1 n2 bastion unable to restart after the WSG-009 scope change.
  machine_type          = "e2-standard-2"
  image                 = "ubuntu-os-cloud/ubuntu-2204-lts"
  zone                  = var.gcp_zone
  network               = module.vpc.network
  subnetwork            = module.vpc.subnets_id[0]
  enable_iap            = true
  enable_oslogin        = true
  service_account_email = module.iam-sa.service_accounts["cloudsql-proxy-service-account"].email
  gcp_project_id        = var.gcp_project_id
  # No external IP (pentest finding WSG-004, DEV-10985): SSH goes through IAP to the internal IP,
  # the DB/Redis targets are reached over private peering, and outbound traffic (apt, Google APIs)
  # egresses via Cloud NAT / Private Google Access.
  give_external_ip = false

  metadata_startup_script = <<-EOT
    #!/bin/bash
    # Just make sure the instance is up to date for now
    apt update -y && apt upgrade -y
  EOT

  depends_on = [module.vpc, module.iam-sa]
}

## ---------------------------------------------------------------------------------------------------------------------
## Read-only DB inspection access to the Cloud SQL bastion
## ---------------------------------------------------------------------------------------------------------------------
# Let the per-dev read-only service accounts (members of role_readonly_sa@) reach the Cloud SQL bastion so they can run
# terraform/tools/connect_to_gcp_db_readonly.sh — read-only DB inspection, including by AI agents. Both bindings are
# scoped to THIS instance (not the project) and are connect/login-only: neither can modify any infrastructure. SSH lands
# a NON-privileged shell (roles/compute.osLogin, not osAdminLogin), and the DB is still reachable only as the SELECT-only
# Postgres "readonly" user. Requires enable_oslogin=true on the instance above, plus iam.serviceAccountUser on the
# attached SA (granted via cloudsql-proxy-service-account's service_account_users in the service_accounts local above).
resource "google_iap_tunnel_instance_iam_member" "readonly_sa_bastion_tunnel" {
  project  = var.gcp_project_id
  zone     = var.gcp_zone
  instance = module.gce_instance.instance_name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "group:role_readonly_sa@whalesync.com"
}

resource "google_compute_instance_iam_member" "readonly_sa_bastion_oslogin" {
  project       = var.gcp_project_id
  zone          = var.gcp_zone
  instance_name = module.gce_instance.instance_name
  role          = "roles/compute.osLogin"
  member        = "group:role_readonly_sa@whalesync.com"
}

# Keep operators' SSH to the bastion working AFTER enabling OS Login (it supersedes the metadata-key SSH they used
# before). osAdminLogin gives the ops group sudo on the box; they already hold iam.serviceAccountUser + IAP access.
# This is the guard that prevents the OS Login flip from locking admins out.
resource "google_compute_instance_iam_member" "operations_bastion_osadminlogin" {
  project       = var.gcp_project_id
  zone          = var.gcp_zone
  instance_name = module.gce_instance.instance_name
  role          = "roles/compute.osAdminLogin"
  member        = "group:role_operations@whalesync.com"
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
  machine_type            = var.scratch_git_machine_type
  zone                    = var.gcp_zone
  region                  = var.gcp_region
  network                 = module.vpc.network
  subnetwork              = module.vpc.subnets_id[0]
  gcp_project_id          = var.gcp_project_id
  service_account_email   = module.iam-sa.service_accounts["scratch-git-service-account"].email
  docker_image            = "${local.artifact_registry_url}/spinner-scratch-git:latest"
  network_name            = local.vpc_network_name
  vpc_cidr_ranges         = [for s in local.custom_subnetworks : s.ip_cidr_range]
  boot_disk_size_gb       = var.scratch_git_boot_disk_size_gb
  disk_size_gb            = var.scratch_git_disk_size_gb
  disk_source_snapshot    = var.scratch_git_disk_source_snapshot
  initialize_filesystem   = var.scratch_git_initialize_filesystem
  snapshot_hours_in_cycle = var.scratch_git_snapshot_hours_in_cycle
  labels                  = merge(local.default_labels, local.vanta_user_data_labels)

  depends_on = [module.vpc, module.iam-sa]
}

## ---------------------------------------------------------------------------------------------------------------------
## Restricted, read-only SSH inspection of the scratch-git VM (DEV-10366)
## ---------------------------------------------------------------------------------------------------------------------
# Let the per-dev read-only service accounts ("gcp-ro", members of role_readonly_sa@) SSH the scratch-git VM to inspect
# it read-only — view Docker state/logs, disk usage, and read repos via the four `sudo gitops-*` wrappers the startup
# script installs. This is the scratch-git analogue of the Cloud SQL bastion grants above and is the WHOLE POINT of the
# ticket: an AI agent on a dev's workstation runs as this read-only SA, so the restricted tier must be reachable BY that
# SA. Both bindings are scoped to THIS instance (not the project) and are connect/login-only — neither can modify any
# infrastructure. SSH lands a NON-privileged shell (roles/compute.osLogin, NOT osAdminLogin → no sudo, not in the docker
# group), and on-VM the user can only run the read-only gitops wrappers. The third piece — actAs (iam.serviceAccountUser)
# on the attached scratch-git-service-account, without which OS Login SSH fails with "Permission denied (publickey)" — is
# granted via that SA's service_account_users in the service_accounts local above. role_readonly_sa@ already holds
# project-wide compute.viewer + logging.viewer (see readonly_sa_roles), so it can already see the instance and read the
# gcplogs container logs. Any mutation/cleanup stays break-glass via role_operations@'s existing osAdminLogin root path.
resource "google_iap_tunnel_instance_iam_member" "readonly_sa_scratch_git_tunnel" {
  count    = var.enable_scratch_git ? 1 : 0
  project  = var.gcp_project_id
  zone     = var.gcp_zone
  instance = module.scratch_git_gce[0].instance_name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "group:role_readonly_sa@whalesync.com"
}

resource "google_compute_instance_iam_member" "readonly_sa_scratch_git_oslogin" {
  count         = var.enable_scratch_git ? 1 : 0
  project       = var.gcp_project_id
  zone          = var.gcp_zone
  instance_name = module.scratch_git_gce[0].instance_name
  role          = "roles/compute.osLogin"
  member        = "group:role_readonly_sa@whalesync.com"
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

  labels = merge(local.default_labels, local.vanta_user_data_labels, {
    # Used to help the connect_to_gcp_* scripts to find the right instance automatically
    "primary" = "true"
  })
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

  labels = merge(local.default_labels, local.vanta_user_data_labels, {
    # Used to help the connect_to_gcp_* scripts to find the right instance automatically
    "primary" = "true"
  })

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

resource "google_secret_manager_secret_version" "READONLY_DB_PASSWORD" {
  secret         = google_secret_manager_secret.required["READONLY_DB_PASSWORD"].id
  secret_data_wo = module.db_primary.readonly_password

  # NOTE: This must be incremented to write a new version of the secret
  secret_data_wo_version = 1
}

## ---------------------------------------------------------------------------------------------------------------------
## GCS Access Logs Bucket
##
## Destination for GCS usage/access logs from every other bucket in this
## project (DEV-10995, Oneleet WSG-014). GCS itself delivers the hourly log
## objects, and Google recommends against a bucket logging to itself, so this
## bucket has no logging block of its own.
## ---------------------------------------------------------------------------------------------------------------------

resource "google_storage_bucket" "gcs_access_logs" {
  name          = "${var.gcp_project_id}-gcs-access-logs"
  location      = var.gcp_region
  force_destroy = false

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  versioning {
    enabled = true
  }

  # Pin GCS's default 7-day soft delete so it can't be silently disabled.
  soft_delete_policy {
    retention_duration_seconds = 604800 # 7 days
  }

  lifecycle_rule {
    condition {
      age = 365
    }
    action {
      type = "Delete"
    }
  }

  labels = local.default_labels
}

# GCS writes usage/access logs as this Google-managed group; it needs create access on the destination bucket.
resource "google_storage_bucket_iam_member" "gcs_access_logs_writer" {
  bucket = google_storage_bucket.gcs_access_logs.name
  role   = "roles/storage.objectCreator"
  member = "group:cloud-storage-analytics@google.com"
}

## ---------------------------------------------------------------------------------------------------------------------
## Asset Rehosting Bucket
## ---------------------------------------------------------------------------------------------------------------------

resource "google_storage_bucket" "assets" {
  name          = "${var.gcp_project_id}-assets"
  location      = var.gcp_region
  force_destroy = false

  uniform_bucket_level_access = true
  cors {
    method = ["GET"]
    origin = [var.client_domain]
  }

  # Versioning + access logs per Oneleet finding WSG-014 (DEV-10995). Noncurrent versions exist only to recover from
  # accidental overwrite/deletion, so they are dropped after 30 days to bound storage growth.
  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800 # 7 days
  }

  lifecycle_rule {
    condition {
      days_since_noncurrent_time = 30
    }
    action {
      type = "Delete"
    }
  }

  logging {
    log_bucket = google_storage_bucket.gcs_access_logs.name
  }

  labels = merge(local.default_labels, local.vanta_user_data_labels)

  depends_on = [google_storage_bucket_iam_member.gcs_access_logs_writer]
}

resource "google_storage_bucket_iam_member" "assets_cloudrun" {
  bucket = google_storage_bucket.assets.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${module.iam-sa.service_accounts["cloudrun-service-account"].email}"
}

# Makes objects in the assets bucket publicly readable, but not listable
resource "google_storage_bucket_iam_member" "assets_public_read" {
  bucket = google_storage_bucket.assets.name
  role   = "projects/${var.gcp_project_id}/roles/${google_project_iam_custom_role.assets_object_reader.role_id}"
  member = "allUsers"
}

resource "google_project_iam_custom_role" "assets_object_reader" {
  role_id     = "assetsObjectReader"
  title       = "Assets Object Reader"
  description = "Allows reading individual objects but not listing bucket contents"
  permissions = ["storage.objects.get"]
}

## ---------------------------------------------------------------------------------------------------------------------
## Publish-Patch Upload Bucket
##
## Holds short-lived publish-patch payloads uploaded by CLI / desktop via
## presigned PUT (`/upload-patch/init`). Intentionally separate from the asset
## bucket: patches contain user record data and must not live in the
## publicly-readable asset bucket. Auto-deletes objects after 24h — patches are
## processed within minutes, so longer retention only widens the window of
## data at rest.
##
## CORS is wildcard-permissive: the signed URL is the auth (short TTL,
## per-upload, server-issued only to the authenticated session), so origin
## restriction would add no real security and would just block future
## browser-based callers.
## ---------------------------------------------------------------------------------------------------------------------

resource "google_storage_bucket" "upload_patches" {
  name          = "${var.gcp_project_id}-upload-patches"
  location      = var.gcp_region
  force_destroy = false

  uniform_bucket_level_access = true

  # The age rule applies to live and noncurrent objects alike, so with versioning enabled (Oneleet WSG-014,
  # DEV-10995) noncurrent patch payloads are still purged a day after the live copy is deleted.
  lifecycle_rule {
    condition {
      age = 1 # days — patches are processed within minutes
    }
    action {
      type = "Delete"
    }
  }

  versioning {
    enabled = true
  }

  soft_delete_policy {
    retention_duration_seconds = 604800 # 7 days
  }

  logging {
    log_bucket = google_storage_bucket.gcs_access_logs.name
  }

  cors {
    origin          = ["*"]
    method          = ["PUT"]
    response_header = ["Content-Type"]
    max_age_seconds = 3600
  }

  labels = merge(local.default_labels, local.vanta_user_data_labels)

  depends_on = [google_storage_bucket_iam_member.gcs_access_logs_writer]
}

resource "google_storage_bucket_iam_member" "upload_patches_cloudrun" {
  bucket = google_storage_bucket.upload_patches.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${module.iam-sa.service_accounts["cloudrun-service-account"].email}"
}
# Deliberately no allUsers grant. Read access is server-only.

## ---------------------------------------------------------------------------------------------------------------------
## Static Assets Bucket + LB
## ---------------------------------------------------------------------------------------------------------------------

module "static_bucket_lb" {
  count  = var.enable_static_assets_lb ? 1 : 0
  source = "../../modules/static_bucket_lb"

  name            = "${var.env_name}-static"
  gcp_project_id  = var.gcp_project_id
  bucket_location = var.gcp_region
  domain          = var.static_assets_domain
  cors_origins    = ["https://${var.client_domain}"]
  log_bucket      = google_storage_bucket.gcs_access_logs.name

  depends_on = [google_storage_bucket_iam_member.gcs_access_logs_writer]
}

