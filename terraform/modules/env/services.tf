locals {
  # Generate a random UUID when force_reload_services is true to trigger service redeployment
  force_reload_uuid = var.force_reload_services ? uuid() : null
}

#region client_service

resource "google_cloud_run_v2_service" "client_service" {
  name     = "client-service"
  location = var.gcp_region

  deletion_protection = false

  template {
    # Use gen1 environment for faster cold starts.
    execution_environment = "EXECUTION_ENVIRONMENT_GEN1"

    scaling {
      min_instance_count = var.client_service_min_instance_count
      max_instance_count = var.client_service_max_instance_count
    }
    service_account = module.iam-sa.service_accounts["cloudrun-service-account"].email
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = module.vpc.network_id
        subnetwork = module.vpc.subnets_id[0]
      }
    }

    containers {
      image = "${local.artifact_registry_url}/spinner-client:latest"

      resources {
        limits = {
          cpu    = var.client_service_cpu_limit
          memory = var.client_service_memory_limit
        }
        cpu_idle          = true # This service responds to requests so it doesn't need CPU all the time.
        startup_cpu_boost = true
      }

      env {
        name  = "SERVICE_TYPE"
        value = "client"
      }
      env {
        name  = "GCP_PROJECT_NUMBER"
        value = var.gcp_project_number
      }
      env {
        name  = "RUNNING_IN_CLOUD"
        value = "true"
      }
      env {
        name = "CLERK_SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = "CLERK_SECRET_KEY"
            version = "latest"
          }
        }
      }
      env {
        name  = "NODE_OPTIONS"
        value = var.client_service_node_options
      }

      dynamic "env" {
        for_each = var.force_reload_services ? [1] : []
        content {
          name  = "FORCE_RELOAD"
          value = local.force_reload_uuid
        }
      }
      dynamic "env" {
        for_each = var.maintenance_mode_enabled ? [1] : []
        content {
          name  = "MAINTENANCE_MODE_ENABLED"
          value = "true"
        }
      }

      startup_probe {
        http_get {
          path = "/api/health"
        }
        initial_delay_seconds = 10
        timeout_seconds       = 3
        period_seconds        = 3
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/api/health"
        }
        initial_delay_seconds = 3
        timeout_seconds       = 3
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image, # Ignore changes to the image version after initial creation
      client,
      client_version,
    ]
  }
}

resource "google_cloud_run_service_iam_member" "client_service_public" {
  service  = google_cloud_run_v2_service.client_service.name
  location = google_cloud_run_v2_service.client_service.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

## ---------------------------------------------------------------------------------------------------------------------
## Load Balancer for Client Service
## ---------------------------------------------------------------------------------------------------------------------

module "client_lb" {
  count  = var.enable_client_load_balancer ? 1 : 0
  source = "../../modules/cloudrun_lb"

  name                   = "${var.env_name}-client"
  region                 = var.gcp_region
  cloud_run_service_name = google_cloud_run_v2_service.client_service.name
  domains                = [var.client_domain]
  enable_cdn             = var.enable_client_cdn
  enable_http_redirect   = true
  log_sample_rate        = 1.0

  depends_on = [google_cloud_run_v2_service.client_service]
}

#endregion

#region api_service

resource "google_cloud_run_v2_service" "api_service" {
  name     = "api-service"
  location = var.gcp_region

  deletion_protection = false

  template {
    # Use gen1 environment for faster cold starts, but gen2 is required for sidecar containers (e.g. OTel collector).
    execution_environment = var.use_opentelemetry_metrics ? "EXECUTION_ENVIRONMENT_GEN2" : "EXECUTION_ENVIRONMENT_GEN1"

    scaling {
      min_instance_count = var.api_service_min_instance_count
      max_instance_count = var.api_service_max_instance_count
    }
    service_account = module.iam-sa.service_accounts["cloudrun-service-account"].email
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = module.vpc.network_id
        subnetwork = module.vpc.subnets_id[0]
      }
    }

    containers {
      name       = "app"
      image      = "${local.artifact_registry_url}/spinner-server:latest"
      depends_on = var.use_opentelemetry_metrics ? ["otel-collector"] : []

      resources {
        limits = {
          cpu    = var.api_service_cpu_limit
          memory = var.api_service_memory_limit
        }
        cpu_idle          = true # This service responds to requests so it doesn't need CPU all the time.
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = merge(
          {
            "APP_ENV" : var.app_env != null ? var.app_env : var.env_name,
            "GCP_PROJECT_NUMBER" : var.gcp_project_number,
            "GCS_ASSET_BUCKET" : google_storage_bucket.assets.name,
            "GCS_PATCH_UPLOAD_BUCKET" : google_storage_bucket.upload_patches.name,
            "NODE_ENV" : "production",
            "NODE_OPTIONS" : var.api_service_node_options,
            "NOTION_PAGE_SIZE" : "100",
            "POSTHOG_HOST" : "https://us.i.posthog.com",
            "REDIRECT_URI" : "https://${var.client_domain}/oauth/callback",
            "REDIS_HOST" : module.redis.host,
            "REDIS_PORT" : module.redis.port,
            "RUNNING_IN_CLOUD" : "true",
            "LANGSMITH_TRACING" : "true",
            "LANGSMITH_ENDPOINT" : "https://eu.api.smith.langchain.com",
            "LANGSMITH_PROJECT" : var.langsmith_project,
            "SERVICE_TYPE" : "api",
            "SLACK_NOTIFICATION_ENABLED" : "true",
            "USE_JOBS" : "true",
            "WORKER_CONCURRENCY" : tostring(var.worker_concurrency),
          },
          var.enable_scratch_git ? {
            "SCRATCH_GIT_API_URL" : "http://${module.scratch_git_gce[0].lb_ip}:3100",
            "SCRATCH_GIT_BACKEND_URL" : "http://${module.scratch_git_gce[0].lb_ip}:3101"
          } : {},
          # Only the api service serves browser HTTP requests, so CORS origins are needed here only.
          length(var.whalesync_app_origins) > 0 ? {
            "WHALESYNC_APP_ORIGINS" : join(",", var.whalesync_app_origins)
          } : {}


        )
        content {
          name  = env.key
          value = env.value
        }
      }

      # Inject the following secrets into the container as env vars
      dynamic "env" {
        for_each = [
          "AIRTABLE_CLIENT_ID",
          "AIRTABLE_CLIENT_SECRET",
          "CLERK_PUBLISHABLE_KEY",
          "CLERK_SECRET_KEY",
          "DATABASE_URL",
          "ENCRYPTION_MASTER_KEY",
          "GEMINI_API_KEY",
          "GITHUB_RELEASES_TOKEN",
          "GOHIGHLEVEL_CLIENT_ID",
          "GOHIGHLEVEL_CLIENT_SECRET",
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "LANGSMITH_API_KEY",
          "LINEAR_API_KEY",
          "LINEAR_OAUTH_CLIENT_ID",
          "LINEAR_OAUTH_CLIENT_SECRET",
          "NOTION_CLIENT_ID",
          "NOTION_CLIENT_SECRET",
          "OPENROUTER_API_KEY",
          "POSTHOG_API_KEY",
          "POSTHOG_FEATURE_FLAG_API_KEY",
          "QUICKBOOKS_CLIENT_ID",
          "QUICKBOOKS_CLIENT_SECRET",
          "REDIS_PASSWORD",
          "SCRATCH_ADMIN_API_KEY",
          "SENDGRID_API_KEY",
          "SHOPIFY_CLIENT_ID",
          "SHOPIFY_CLIENT_SECRET",
          "SLACK_NOTIFICATION_WEBHOOK_URL",
          "STRIPE_API_KEY",
          "STRIPE_WEBHOOK_SECRET",
          "WEBFLOW_CLIENT_ID",
          "WEBFLOW_CLIENT_SECRET",
          "WIX_CLIENT_ID",
          "WIX_CLIENT_SECRET",
          "SUPABASE_CLIENT_ID",
          "SUPABASE_CLIENT_SECRET",
          "ZOHO_CLIENT_ID",
          "ZOHO_CLIENT_SECRET",
        ]
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.force_reload_services ? [1] : []
        content {
          name  = "FORCE_RELOAD"
          value = local.force_reload_uuid
        }
      }
      dynamic "env" {
        for_each = var.use_opentelemetry_metrics ? [1] : []
        content {
          name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
          value = "http://localhost:4318"
        }
      }
      dynamic "env" {
        for_each = var.use_opentelemetry_metrics ? [1] : []
        content {
          name  = "USE_OPENTELEMETRY_METRICS"
          value = "true"
        }
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 10
        timeout_seconds       = 3
        period_seconds        = 3
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 3
        timeout_seconds       = 3
      }
    }

    # OpenTelemetry Collector sidecar
    dynamic "containers" {
      for_each = var.use_opentelemetry_metrics ? [1] : []
      content {
        name  = "otel-collector"
        image = var.otel_collector_image
        args  = ["--config=/etc/otelcol-google/config.yaml"]

        resources {
          limits = {
            cpu    = var.opentelemetry_collector_cpu_limit
            memory = var.opentelemetry_collector_memory_limit
          }
          cpu_idle          = true
          startup_cpu_boost = true
        }

        startup_probe {
          http_get {
            path = "/"
            port = 13133
          }
          timeout_seconds = 30
          period_seconds  = 30
        }

        liveness_probe {
          http_get {
            path = "/"
            port = 13133
          }
          timeout_seconds = 30
          period_seconds  = 30
        }

        volume_mounts {
          name       = "config"
          mount_path = "/etc/otelcol-google/"
        }
      }
    }

    dynamic "volumes" {
      for_each = var.use_opentelemetry_metrics ? [1] : []
      content {
        name = "config"
        secret {
          secret = google_secret_manager_secret.OTEL_COLLECTOR_CONFIG[0].secret_id
          items {
            version = google_secret_manager_secret_version.OTEL_COLLECTOR_CONFIG[0].version
            path    = "config.yaml"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image, # Ignore changes to the image version after initial creation
      client,
      client_version,
    ]
  }
}

resource "google_cloud_run_service_iam_member" "api_service_public" {
  service  = google_cloud_run_v2_service.api_service.name
  location = google_cloud_run_v2_service.api_service.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}

module "api_lb" {
  source = "../../modules/cloudrun_lb"

  name                   = "${var.env_name}-api"
  region                 = var.gcp_region
  cloud_run_service_name = google_cloud_run_v2_service.api_service.name
  domains                = [var.api_domain]
  enable_cdn             = false
  enable_http_redirect   = true
  log_sample_rate        = 1.0
}

#endregion

#region cron_service

resource "google_cloud_run_v2_service" "cron_service" {
  name     = "cron-service"
  location = var.gcp_region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  deletion_protection = false

  template {
    # Use gen1 environment for faster cold starts, but gen2 is required for sidecar containers (e.g. OTel collector).
    execution_environment = var.use_opentelemetry_metrics ? "EXECUTION_ENVIRONMENT_GEN2" : "EXECUTION_ENVIRONMENT_GEN1"

    scaling {
      min_instance_count = 1
      max_instance_count = 1
    }
    service_account = module.iam-sa.service_accounts["cloudrun-service-account"].email
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = module.vpc.network_id
        subnetwork = module.vpc.subnets_id[0]
      }
    }

    containers {
      name       = "app"
      image      = "${local.artifact_registry_url}/spinner-server:latest"
      depends_on = var.use_opentelemetry_metrics ? ["otel-collector"] : []

      resources {
        limits = {
          cpu    = var.cron_service_cpu_limit
          memory = var.cron_service_memory_limit
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = merge(
          {
            "APP_ENV" : var.app_env != null ? var.app_env : var.env_name,
            "GCP_PROJECT_NUMBER" : var.gcp_project_number,
            "GCS_ASSET_BUCKET" : google_storage_bucket.assets.name,
            "GCS_PATCH_UPLOAD_BUCKET" : google_storage_bucket.upload_patches.name,
            "NODE_ENV" : "production",
            "NODE_OPTIONS" : var.cron_service_node_options,
            "NOTION_PAGE_SIZE" : "100",
            "POSTHOG_HOST" : "https://us.i.posthog.com",
            "REDIRECT_URI" : "https://${var.client_domain}/oauth/callback",
            "REDIS_HOST" : module.redis.host,
            "REDIS_PORT" : module.redis.port,
            "RUNNING_IN_CLOUD" : "true",
            "LANGSMITH_TRACING" : "true",
            "LANGSMITH_ENDPOINT" : "https://eu.api.smith.langchain.com",
            "LANGSMITH_PROJECT" : var.langsmith_project,
            "SERVICE_TYPE" : "cron",
            "SLACK_NOTIFICATION_ENABLED" : "true",
            "USE_JOBS" : "true",
            "WORKER_CONCURRENCY" : tostring(var.worker_concurrency),
          },
          var.enable_scratch_git ? {
            "SCRATCH_GIT_API_URL" : "http://${module.scratch_git_gce[0].lb_ip}:3100",
            "SCRATCH_GIT_BACKEND_URL" : "http://${module.scratch_git_gce[0].lb_ip}:3101"
          } : {}


        )
        content {
          name  = env.key
          value = env.value
        }
      }

      # Inject the following secrets into the container as env vars
      dynamic "env" {
        for_each = [
          "AIRTABLE_CLIENT_ID",
          "AIRTABLE_CLIENT_SECRET",
          "CLERK_PUBLISHABLE_KEY",
          "CLERK_SECRET_KEY",
          "DATABASE_URL",
          "ENCRYPTION_MASTER_KEY",
          "GEMINI_API_KEY",
          "GITHUB_RELEASES_TOKEN",
          "GOHIGHLEVEL_CLIENT_ID",
          "GOHIGHLEVEL_CLIENT_SECRET",
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "LANGSMITH_API_KEY",
          "LINEAR_API_KEY",
          "NOTION_CLIENT_ID",
          "NOTION_CLIENT_SECRET",
          "OPENROUTER_API_KEY",
          "POSTHOG_API_KEY",
          "POSTHOG_FEATURE_FLAG_API_KEY",
          "QUICKBOOKS_CLIENT_ID",
          "QUICKBOOKS_CLIENT_SECRET",
          "REDIS_PASSWORD",
          "SENDGRID_API_KEY",
          "SLACK_NOTIFICATION_WEBHOOK_URL",
          "STRIPE_API_KEY",
          "STRIPE_WEBHOOK_SECRET",
          "WEBFLOW_CLIENT_ID",
          "WEBFLOW_CLIENT_SECRET",
          "WIX_CLIENT_ID",
          "WIX_CLIENT_SECRET",
          "SUPABASE_CLIENT_ID",
          "SUPABASE_CLIENT_SECRET",
          "ZOHO_CLIENT_ID",
          "ZOHO_CLIENT_SECRET",
        ]
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.force_reload_services ? [1] : []
        content {
          name  = "FORCE_RELOAD"
          value = local.force_reload_uuid
        }
      }
      dynamic "env" {
        for_each = var.use_opentelemetry_metrics ? [1] : []
        content {
          name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
          value = "http://localhost:4318"
        }
      }
      dynamic "env" {
        for_each = var.use_opentelemetry_metrics ? [1] : []
        content {
          name  = "USE_OPENTELEMETRY_METRICS"
          value = "true"
        }
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 10
        timeout_seconds       = 3
        period_seconds        = 3
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 3
        timeout_seconds       = 3
      }
    }

    # OpenTelemetry Collector sidecar
    dynamic "containers" {
      for_each = var.use_opentelemetry_metrics ? [1] : []
      content {
        name  = "otel-collector"
        image = var.otel_collector_image
        args  = ["--config=/etc/otelcol-google/config.yaml"]

        resources {
          limits = {
            cpu    = var.opentelemetry_collector_cpu_limit
            memory = var.opentelemetry_collector_memory_limit
          }
          cpu_idle          = false
          startup_cpu_boost = true
        }

        startup_probe {
          http_get {
            path = "/"
            port = 13133
          }
          timeout_seconds = 30
          period_seconds  = 30
        }

        liveness_probe {
          http_get {
            path = "/"
            port = 13133
          }
          timeout_seconds = 30
          period_seconds  = 30
        }

        volume_mounts {
          name       = "config"
          mount_path = "/etc/otelcol-google/"
        }
      }
    }

    dynamic "volumes" {
      for_each = var.use_opentelemetry_metrics ? [1] : []
      content {
        name = "config"
        secret {
          secret = google_secret_manager_secret.OTEL_COLLECTOR_CONFIG[0].secret_id
          items {
            version = google_secret_manager_secret_version.OTEL_COLLECTOR_CONFIG[0].version
            path    = "config.yaml"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image, # Ignore changes to the image version after initial creation
      client,
      client_version,
    ]
  }
}

#endregion

#region worker_service

resource "google_cloud_run_v2_service" "worker_service" {
  name     = "worker-service"
  location = var.gcp_region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  deletion_protection = false

  template {
    execution_environment = "EXECUTION_ENVIRONMENT_GEN1"

    scaling {
      min_instance_count = var.worker_service_min_instance_count
      max_instance_count = var.worker_service_max_instance_count
    }
    service_account = module.iam-sa.service_accounts["cloudrun-service-account"].email
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = module.vpc.network_id
        subnetwork = module.vpc.subnets_id[0]
      }
    }

    containers {
      name       = "app"
      image      = "${local.artifact_registry_url}/spinner-server:latest"
      depends_on = var.use_opentelemetry_metrics ? ["otel-collector"] : []

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = var.worker_service_cpu_limit
          memory = var.worker_service_memory_limit
        }
        cpu_idle          = false
        startup_cpu_boost = true
      }

      dynamic "env" {
        for_each = merge(
          {
            "APP_ENV" : var.app_env != null ? var.app_env : var.env_name,
            "GCP_PROJECT_NUMBER" : var.gcp_project_number,
            "GCS_ASSET_BUCKET" : google_storage_bucket.assets.name,
            "GCS_PATCH_UPLOAD_BUCKET" : google_storage_bucket.upload_patches.name,
            "NODE_ENV" : "production",
            "NODE_OPTIONS" : var.worker_service_node_options,
            "NOTION_PAGE_SIZE" : "100",
            "POSTHOG_HOST" : "https://us.i.posthog.com",
            "REDIRECT_URI" : "https://${var.client_domain}/oauth/callback",
            "REDIS_HOST" : module.redis.host,
            "REDIS_PORT" : module.redis.port,
            "RUNNING_IN_CLOUD" : "true",
            "LANGSMITH_TRACING" : "true",
            "LANGSMITH_ENDPOINT" : "https://eu.api.smith.langchain.com",
            "LANGSMITH_PROJECT" : var.langsmith_project,
            "SERVICE_TYPE" : "worker",
            "SLACK_NOTIFICATION_ENABLED" : "true",
            "USE_JOBS" : "true",
            "WORKER_CONCURRENCY" : tostring(var.worker_concurrency),
          },
          var.enable_scratch_git ? {
            "SCRATCH_GIT_API_URL" : "http://${module.scratch_git_gce[0].lb_ip}:3100",
            "SCRATCH_GIT_BACKEND_URL" : "http://${module.scratch_git_gce[0].lb_ip}:3101"
          } : {}


        )
        content {
          name  = env.key
          value = env.value
        }
      }

      # Inject the following secrets into the container as env vars
      dynamic "env" {
        for_each = [
          "AIRTABLE_CLIENT_ID",
          "AIRTABLE_CLIENT_SECRET",
          "CLERK_PUBLISHABLE_KEY",
          "CLERK_SECRET_KEY",
          "DATABASE_URL",
          "ENCRYPTION_MASTER_KEY",
          "GEMINI_API_KEY",
          "GOHIGHLEVEL_CLIENT_ID",
          "GOHIGHLEVEL_CLIENT_SECRET",
          "GOOGLE_CLIENT_ID",
          "GOOGLE_CLIENT_SECRET",
          "LANGSMITH_API_KEY",
          "LINEAR_API_KEY",
          "NOTION_CLIENT_ID",
          "NOTION_CLIENT_SECRET",
          "OPENROUTER_API_KEY",
          "POSTHOG_API_KEY",
          "POSTHOG_FEATURE_FLAG_API_KEY",
          "QUICKBOOKS_CLIENT_ID",
          "QUICKBOOKS_CLIENT_SECRET",
          "REDIS_PASSWORD",
          "SENDGRID_API_KEY",
          "SLACK_NOTIFICATION_WEBHOOK_URL",
          "STRIPE_API_KEY",
          "STRIPE_WEBHOOK_SECRET",
          "WEBFLOW_CLIENT_ID",
          "WEBFLOW_CLIENT_SECRET",
          "WIX_CLIENT_ID",
          "WIX_CLIENT_SECRET",
          "SUPABASE_CLIENT_ID",
          "SUPABASE_CLIENT_SECRET",
          "ZOHO_CLIENT_ID",
          "ZOHO_CLIENT_SECRET",
        ]
        content {
          name = env.value
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      dynamic "env" {
        for_each = var.force_reload_services ? [1] : []
        content {
          name  = "FORCE_RELOAD"
          value = local.force_reload_uuid
        }
      }
      dynamic "env" {
        for_each = var.use_opentelemetry_metrics ? [1] : []
        content {
          name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
          value = "http://localhost:4318"
        }
      }
      dynamic "env" {
        for_each = var.use_opentelemetry_metrics ? [1] : []
        content {
          name  = "USE_OPENTELEMETRY_METRICS"
          value = "true"
        }
      }

      startup_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 10
        timeout_seconds       = 3
        period_seconds        = 3
        failure_threshold     = 3
      }

      liveness_probe {
        http_get {
          path = "/health"
        }
        initial_delay_seconds = 3
        timeout_seconds       = 3
      }
    }

    # OpenTelemetry Collector sidecar
    dynamic "containers" {
      for_each = var.use_opentelemetry_metrics ? [1] : []
      content {
        name  = "otel-collector"
        image = var.otel_collector_image
        args  = ["--config=/etc/otelcol-google/config.yaml"]

        resources {
          limits = {
            cpu    = var.opentelemetry_collector_cpu_limit
            memory = var.opentelemetry_collector_memory_limit
          }
          cpu_idle          = false
          startup_cpu_boost = true
        }

        startup_probe {
          http_get {
            path = "/"
            port = 13133
          }
          timeout_seconds = 30
          period_seconds  = 30
        }

        liveness_probe {
          http_get {
            path = "/"
            port = 13133
          }
          timeout_seconds = 30
          period_seconds  = 30
        }

        volume_mounts {
          name       = "config"
          mount_path = "/etc/otelcol-google/"
        }
      }
    }

    dynamic "volumes" {
      for_each = var.use_opentelemetry_metrics ? [1] : []
      content {
        name = "config"
        secret {
          secret = google_secret_manager_secret.OTEL_COLLECTOR_CONFIG[0].secret_id
          items {
            version = google_secret_manager_secret_version.OTEL_COLLECTOR_CONFIG[0].version
            path    = "config.yaml"
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image, # Ignore changes to the image version after initial creation
      client,
      client_version,
    ]
  }
}

#endregion

