#
# Custom roles
#
# Instead of using default roles, Vanta prefers it if we use custom roles with limited permissions.
#

## ---------------------------------------------------------------------------------------------------------------------
## IAM Default Service Accounts - Remove Default Roles
## ---------------------------------------------------------------------------------------------------------------------

resource "google_project_iam_custom_role" "compute_engine_service_account_role" {
  role_id     = "computeEngineServiceAccountCustomRole"
  title       = "CE Custom Default Service Account Role"
  description = "Custom Role for the Compute Engine default service account"
  permissions = [
    "logging.logEntries.create",
    "monitoring.timeSeries.create",
    "cloudkms.cryptoKeyVersions.useToDecrypt",
    "cloudkms.cryptoKeyVersions.useToEncrypt",
    "cloudkms.locations.get",
    "cloudkms.locations.list",
    "resourcemanager.projects.get",
  ]
  depends_on = [google_project_service.services]
}

resource "google_project_iam_member" "compute_engine_service_assign_role" {
  project    = var.gcp_project_id
  role       = "projects/${var.gcp_project_id}/roles/${google_project_iam_custom_role.compute_engine_service_account_role.role_id}"
  member     = "serviceAccount:${var.gcp_project_number}-compute@developer.gserviceaccount.com"
  depends_on = [google_project_service.services]
}

## ---------------------------------------------------------------------------------------------------------------------
## Cloud Run runtime service account — least-privilege IAM (DEV-10969 / WSG-002)
##
## The Cloud Run runtime SA (cloudrun-service-account@<project>) previously held a ~490-permission project custom role
## (cloudRunServiceAccountCustomRole) that included project-wide privilege-escalation primitives: service-account
## impersonation / token-minting (iam.serviceAccounts.actAs / getAccessToken / getOpenIdToken / implicitDelegation /
## signJwt), IAM-policy modification (storage.* / compute.*.setIamPolicy, compute.instances.setServiceAccount), and
## blanket secretmanager.versions.access. All four services that run as this SA (client, api, cron, worker — two of
## them public) shared it, so a single app-layer RCE could escalate to full project compromise.
##
## We replace that role with exactly what the running code needs:
##   - roles/secretmanager.secretAccessor  → read the secrets Cloud Run injects as env vars at container start
##                                           (services.tf secret_key_ref blocks). The server has NO in-process Secret
##                                           Manager client; secrets only ever arrive as process.env.
##   - roles/monitoring.metricWriter       → the OpenTelemetry collector sidecar (runs under this same SA) emits metrics.
##   - storage object access               → already granted per-bucket via roles/storage.objectAdmin on the assets +
##                                           upload-patches buckets (see main.tf), so no storage grant is needed here.
##   - iam.serviceAccounts.signBlob (self) → needed for V4 signed upload URLs (server/src/asset/object-storage.service.ts
##                                           signPutUrlForPatchUpload). Granted below, scoped to the SA's OWN resource.
##
## NB: the shared iam_service_accounts module ALSO already binds roles/iam.serviceAccountTokenCreator to this SA on
## itself (modules/iam_service_accounts/main.tf:36-46 adds the SA's own member because it has service_account_users).
## That is a self-only grant (the SA can act only as itself, not as any other SA) and is a superset of the signBlob
## grant below. We keep the explicit signBlob binding anyway so the functional dependency is self-documenting and does
## not silently break if that module binding ever changes. Narrowing the module's self-tokenCreator is a separate,
## lower-risk cleanup (self-scoped, not an escalation path) and is intentionally out of scope for this change.
##
## Deploys, image pulls, and DB migrations use a SEPARATE identity (gitlab-service-account@, see main.tf) and are
## unaffected by removing the runtime role.
## ---------------------------------------------------------------------------------------------------------------------

# Minimal role that lets the runtime SA sign blobs AS ITSELF (V4 signed URLs). Bound to the SA resource below, so it
# confers no ability to impersonate or sign for any other service account. No predefined role is this narrow — the
# closest (roles/iam.serviceAccountTokenCreator) would re-introduce getAccessToken / signJwt / getOpenIdToken.
resource "google_project_iam_custom_role" "cloud_run_self_signer_role" {
  role_id     = "cloudRunSelfSignerRole"
  title       = "CR Self Signer Role"
  description = "Allows the Cloud Run runtime service account to sign blobs as itself (V4 signed URLs)"
  permissions = ["iam.serviceAccounts.signBlob"]
  depends_on  = [google_project_service.services]
}

# Read access to Secret Manager so Cloud Run can resolve the secret_key_ref env vars in services.tf at container start.
# Project-wide by choice (simplicity over per-secret bindings); tightening to per-secret secretAccessor bindings driven
# off the services.tf injected list is a possible later step.
resource "google_project_iam_member" "cloud_run_secret_accessor" {
  project    = var.gcp_project_id
  role       = "roles/secretmanager.secretAccessor"
  member     = "serviceAccount:${module.iam-sa.service_accounts["cloudrun-service-account"].email}"
  depends_on = [module.iam-sa]
}

# Metric write for the OpenTelemetry collector sidecar (runs under this same runtime SA).
resource "google_project_iam_member" "cloud_run_metric_writer" {
  project    = var.gcp_project_id
  role       = "roles/monitoring.metricWriter"
  member     = "serviceAccount:${module.iam-sa.service_accounts["cloudrun-service-account"].email}"
  depends_on = [module.iam-sa]
}

# Bind the self-signer role on the SA's OWN resource (member == the SA itself) so signing is confined to its own
# identity and cannot be used to impersonate any other SA in the project.
resource "google_service_account_iam_member" "cloud_run_self_sign_blob" {
  service_account_id = module.iam-sa.service_accounts["cloudrun-service-account"].id
  role               = "projects/${var.gcp_project_id}/roles/${google_project_iam_custom_role.cloud_run_self_signer_role.role_id}"
  member             = "serviceAccount:${module.iam-sa.service_accounts["cloudrun-service-account"].email}"
}

# Additional permissions for the GitLab service account that don't fit into one of GCP's pre-defined roles
resource "google_project_iam_custom_role" "gitlab_tf_service_account_role" {
  role_id     = local.gitlab_custom_role_name
  title       = "GitLab Terraform Custom Service Account Role"
  description = "Custom role for the GitLab service account to run terraform"
  permissions = [
    "artifactregistry.projectsettings.update",
    "artifactregistry.repositories.create",
    "artifactregistry.repositories.createTagBinding",
    "artifactregistry.repositories.delete",
    "artifactregistry.repositories.deleteTagBinding",
    "artifactregistry.repositories.getIamPolicy",
    "artifactregistry.repositories.setIamPolicy",
    "artifactregistry.repositories.update",
    "cloudsql.backupRuns.delete",
    "cloudsql.databases.delete",
    "cloudsql.instances.clone",
    "cloudsql.instances.create",
    "cloudsql.instances.createTagBinding",
    "cloudsql.instances.delete",
    "cloudsql.instances.deleteTagBinding",
    "cloudsql.instances.demoteMaster",
    "cloudsql.instances.executeSql",
    "cloudsql.instances.import",
    "cloudsql.instances.login",
    "cloudsql.instances.promoteReplica",
    "cloudsql.instances.resetSslConfig",
    "cloudsql.instances.restoreBackup",
    "cloudsql.instances.startReplica",
    "cloudsql.instances.stopReplica",
    "cloudsql.sslCerts.create",
    "cloudsql.sslCerts.delete",
    "cloudsql.users.create",
    "cloudsql.users.delete",
    "cloudsql.users.update",
    "iam.roles.create",
    "iam.roles.delete",
    "iam.roles.undelete",
    "iam.roles.update",
    "iam.serviceAccounts.create",
    "iam.serviceAccounts.delete",
    "iam.serviceAccounts.disable",
    "iam.serviceAccounts.enable",
    "iam.serviceAccounts.implicitDelegation",
    "iam.serviceAccounts.setIamPolicy",
    "iam.serviceAccounts.signJwt",
    "iam.serviceAccounts.undelete",
    "iam.serviceAccounts.update",
    "networkmanagement.config.get",
    "networkmanagement.config.startFreeTrial",
    "networkmanagement.config.update",
    "networkmanagement.connectivitytests.create",
    "networkmanagement.connectivitytests.delete",
    "networkmanagement.connectivitytests.getIamPolicy",
    "networkmanagement.connectivitytests.rerun",
    "networkmanagement.connectivitytests.setIamPolicy",
    "networkmanagement.connectivitytests.update",
    "networkmanagement.locations.get",
    "networkmanagement.locations.list",
    "networkmanagement.operations.cancel",
    "networkmanagement.operations.delete",
    "networkmanagement.operations.get",
    "networkmanagement.operations.list",
    "networkmanagement.topologygraphs.read",
    "pubsub.subscriptions.create",
    "pubsub.subscriptions.delete",
    "pubsub.subscriptions.get",
    "pubsub.subscriptions.list",
    "pubsub.topics.attachSubscription",
    "pubsub.topics.create",
    "pubsub.topics.delete",
    "pubsub.topics.get",
    "pubsub.topics.list",
    "pubsub.topics.publish",
    "recommender.cloudsqlInstanceSecurityInsights.get",
    "recommender.cloudsqlInstanceSecurityInsights.list",
    "recommender.cloudsqlInstanceSecurityInsights.update",
    "recommender.cloudsqlInstanceSecurityRecommendations.get",
    "recommender.cloudsqlInstanceSecurityRecommendations.list",
    "recommender.cloudsqlInstanceSecurityRecommendations.update",
    "redis.clusters.connect",
    "redis.clusters.create",
    "redis.clusters.delete",
    "redis.instances.create",
    "redis.instances.createTagBinding",
    "redis.instances.delete",
    "redis.instances.deleteTagBinding",
    "redis.instances.export",
    "redis.instances.getAuthString",
    "redis.instances.import",
    "redis.instances.listEffectiveTags",
    "redis.instances.listTagBindings",
    "redis.instances.rescheduleMaintenance",
    "redis.instances.updateAuth",
    "redis.instances.upgrade",
    "run.jobs.createTagBinding",
    "run.jobs.deleteTagBinding",
    "run.jobs.setIamPolicy",
    "run.services.createTagBinding",
    "run.services.deleteTagBinding",
    "run.services.setIamPolicy",
  ]
  depends_on = [google_project_service.services]
}
