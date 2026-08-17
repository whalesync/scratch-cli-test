locals {
  display_env                = title(var.env_name)
  renotify_interval          = "1800s"  # 30 mins
  extended_renotify_interval = "21600s" # 6 hours
  notification_channels = compact([
    var.enable_email_notifications ? google_monitoring_notification_channel.team_email[0].name : "",
    var.enable_pagerduty_notifications ? google_monitoring_notification_channel.pagerduty[0].name : "",
  ])
  warning_notification_channels = compact([
    var.enable_email_notifications ? google_monitoring_notification_channel.team_email[0].name : "",
    var.enable_slack_notifications ? google_monitoring_notification_channel.slack[0].name : "",
  ])
  alert_database_id             = "${var.gcp_project_id}:${module.db_primary.instance_id}"
  db_connection_alert_threshold = var.db_connection_limit * 0.95
  alert_redis_id                = "projects/${var.gcp_project_id}/locations/${var.gcp_region}/instances/${local.redis_name}"
  # Runbook links (docs/ops/, GitLab master) — replace the deprecated Notion
  # "Firefighting / On-Call (GCP)" playbook (DEV-10748).
  runbook_base                     = "https://gitlab.com/whalesync/spinner/-/blob/master/docs/ops"
  runbook_datastore_alerts         = "${local.runbook_base}/runbook-gcp-datastore-alerts.md"
  runbook_cloud_run_service_errors = "${local.runbook_base}/runbook-gcp-cloud-run-service-errors.md"
  runbook_scratch_git_vm           = "${local.runbook_base}/runbook-scratch-git-unresponsive-production.md"
  runbook_scratch_git_disk         = "${local.runbook_base}/runbook-scratch-git-disk-usage.md"
  runbook_flow_log_alerts          = "${local.runbook_base}/runbook-gcp-vpc-flow-log-alerts.md"
  runbook_desktop_release          = "${local.runbook_base}/runbook-desktop-release-download-broken.md"

  # --- VPC Flow Log anomaly detection ---
  # VPC Flow Logs are already emitted on every subnet (see modules/vpc). These filters
  # power log-based security metrics that replaced the (expensive) Cloud IDS appliance.
  # Country codes in flow logs are ISO 3166-1 alpha-3 lowercase (e.g. "usa", "gbr").
  # "%2F" is the literal "/" in the log name.
  flow_log_base_filter = "resource.type=\"gce_subnetwork\" AND logName=\"projects/${var.gcp_project_id}/logs/compute.googleapis.com%2Fvpc_flows\""
  # RFC 1918 private address space. Any flow whose destination is one of these is staying
  # inside private network space (our VPC subnets, or the peered ranges that back Google
  # managed services like Memorystore Redis and Cloud SQL reached over Private Services
  # Access) — it is not egress to the public internet, so it must never trip the external
  # egress metrics. Cloud Run reaching internal services (e.g. api-service -> Memorystore
  # Redis on 6379 at a 10.x address via Direct VPC egress) lands here.
  # Subnet containment must use ip_in_net(field, subnet) — Cloud Logging's "=" operator
  # does a literal STRING compare, so dest_ip="10.0.0.0/8" never matches "10.167.0.3"
  # (verified against prod flow logs). ip_in_net is a per-subnet predicate, so we OR one
  # call per range and negate the group.
  rfc1918_private_cidrs = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"]
  rfc1918_private_dest_clause = join(" OR ", [
    for cidr in local.rfc1918_private_cidrs : "ip_in_net(jsonPayload.connection.dest_ip, \"${cidr}\")"
  ])
  # Egress leaving the VPC to the public internet: this side is the source, the far side
  # has no internal GCE instance metadata (dest_instance is only set when the destination
  # is a VM in our VPC), the destination is not a Google managed service, and the
  # destination IP is a public (non-RFC-1918) address. The dest_google_service exclusion
  # drops legitimate Private Services Access / Google API traffic (e.g. cloudsql-proxy ->
  # sqladmin.googleapis.com on 5432); the RFC 1918 exclusion drops traffic that stays
  # inside private network space (VPC subnets + peered Google-managed-service ranges),
  # which dest_google_service / dest_instance do not always tag (e.g. Cloud Run ->
  # Memorystore Redis on 6379 at a 10.x address via Direct VPC egress). Field paths must
  # be unquoted — the quoted form ("jsonPayload.dest_instance":*) is rejected by Cloud
  # Logging's metric validation.
  flow_log_external_egress = "${local.flow_log_base_filter} AND jsonPayload.reporter=\"SRC\" AND NOT jsonPayload.dest_instance:* AND NOT jsonPayload.dest_google_service:* AND NOT (${local.rfc1918_private_dest_clause})"
  # Admin / DB / cache ports that should never be the target of egress to the internet.
  # This is intended to flag possible data exfiltration.
  # It should NOT flag any legitimate connection that Scratch makes for syncing data, e.g. HTTPS, Postgres, etc.
  flow_log_suspicious_ports = [
    21,    # FTP
    22,    # SSH / SFTP
    23,    # telnet
    445,   # SMB
    3306,  # MySQL
    3389,  # RDP
    6379,  # Redis
    27017, # MongoDB
  ]
  # Country codes considered normal for traffic to/from the VPC. VPC Flow Logs use
  # ISO 3166-1 alpha-3 lowercase codes (e.g. "usa", "gbr", "irl"), not alpha-2.
  # Scope: our home region (GCP europe-west1 = Belgium) plus the major AWS/GCP/Azure
  # regions and English-speaking countries where connectors legitimately egress (e.g. a
  # customer's Supabase/Postgres/app). Keep this list minimal — every entry is a security
  # detection blind spot; prefer the durable ASN-based fix (DEV-10747) over growing it.
  flow_log_allowed_countries = [
    "usa", "can",                             # North America
    "bel", "irl", "gbr", "deu", "fra", "nld", # Western/Central Europe — major cloud regions
    "swe", "fin", "che", "ita", "esp", "pol", # Nordics + Southern/Central Europe — major cloud regions
    "aus", "nzl",                             # English-speaking (Oceania)
  ]
  # Rendered filter fragments.
  flow_log_suspicious_ports_clause  = "(${join(" OR ", local.flow_log_suspicious_ports)})"
  flow_log_allowed_countries_clause = "(${join(" OR ", [for c in local.flow_log_allowed_countries : "\"${c}\""])})"
  # Per-flow byte size (p99 over the window) that counts as a suspiciously large single
  # egress flow. A DISTRIBUTION metric must be collapsed to a scalar via a percentile
  # aligner before threshold comparison, so this is a single-flow size, not a window total.
  flow_log_egress_byte_spike_threshold = 1073741824 # 1 GiB
}

## ---------------------------------------------------------------------------------------------------------------------
## Notification Channels
## ---------------------------------------------------------------------------------------------------------------------

resource "google_monitoring_notification_channel" "team_email" {
  count = var.enable_email_notifications ? 1 : 0

  display_name = "Team Email"
  type         = "email"
  labels = {
    email_address = var.alert_notification_email
  }
  force_delete = false
  depends_on   = [google_project_service.services]
}

resource "google_monitoring_notification_channel" "pagerduty" {
  count = var.enable_pagerduty_notifications ? 1 : 0

  display_name = "GCP Prod"
  description  = "PagerDuty alerting channel"
  type         = "pagerduty"
  sensitive_labels {
    service_key = data.google_secret_manager_secret_version.pagerduty_integration_key[0].secret_data
  }
  force_delete = false
  depends_on   = [google_project_service.services]
}

# Note: this channel must be created manually in the GCP console first (so the
# Slack OAuth flow can supply an auth_token), then imported into terraform state.
# Changing it later via terraform also requires providing the auth_token, which is
# why we ignore_changes on labels["auth_token"].
resource "google_monitoring_notification_channel" "slack" {
  count = var.enable_slack_notifications ? 1 : 0

  display_name = "${var.alert_notification_channel} in Slack"
  type         = "slack"
  force_delete = false
  labels = {
    channel_name = var.alert_notification_channel
    team         = "Whalesync"
  }
  depends_on = [google_project_service.services]

  lifecycle {
    ignore_changes = [labels["auth_token"]]
  }
}

## ---------------------------------------------------------------------------------------------------------------------
## SLO Monitoring
## ---------------------------------------------------------------------------------------------------------------------

resource "google_monitoring_service" "api_service_monitoring_service" {
  service_id   = "${google_cloud_run_v2_service.api_service.name}-monitoring"
  display_name = google_cloud_run_v2_service.api_service.name

  basic_service {
    service_type = "CLOUD_RUN"
    service_labels = {
      service_name = google_cloud_run_v2_service.api_service.name
      location     = google_cloud_run_v2_service.api_service.location
    }
  }
}

resource "google_monitoring_service" "cron_service_monitoring_service" {
  service_id   = "${google_cloud_run_v2_service.cron_service.name}-monitoring"
  display_name = google_cloud_run_v2_service.cron_service.name

  basic_service {
    service_type = "CLOUD_RUN"
    service_labels = {
      service_name = google_cloud_run_v2_service.cron_service.name
      location     = google_cloud_run_v2_service.cron_service.location
    }
  }
}

resource "google_monitoring_service" "worker_service_monitoring_service" {
  service_id   = "${google_cloud_run_v2_service.worker_service.name}-monitoring"
  display_name = google_cloud_run_v2_service.worker_service.name

  basic_service {
    service_type = "CLOUD_RUN"
    service_labels = {
      service_name = google_cloud_run_v2_service.worker_service.name
      location     = google_cloud_run_v2_service.worker_service.location
    }
  }
}

resource "google_monitoring_service" "client_service_monitoring_service" {
  service_id   = "${google_cloud_run_v2_service.client_service.name}-monitoring"
  display_name = google_cloud_run_v2_service.client_service.name

  basic_service {
    service_type = "CLOUD_RUN"
    service_labels = {
      service_name = google_cloud_run_v2_service.client_service.name
      location     = google_cloud_run_v2_service.client_service.location
    }
  }
}

## ---------------------------------------------------------------------------------------------------------------------
## SQL PROXY VM Alerts
## ---------------------------------------------------------------------------------------------------------------------
resource "google_monitoring_alert_policy" "sqlproxy_cpu_too_high" {
  display_name = "Scratch ${local.display_env} CloudSQL Proxy CPU > 80%"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} CloudSQL Proxy CPU Utilization > 80%"
    content = "Runbook: ${local.runbook_datastore_alerts}"
  }
  combiner = "OR"
  conditions {
    display_name = "VM Instance - CPU utilization"
    condition_threshold {
      aggregations {
        alignment_period   = "900s"
        per_series_aligner = "ALIGN_MEAN"
      }

      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"gce_instance\" AND metric.type = \"compute.googleapis.com/instance/cpu/utilization\" AND metric.labels.instance_name = \"${local.proxy_instance_name}\""
      threshold_value = 0.8
      trigger {
        count = 3
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
  severity              = "WARNING"

  lifecycle {
    // Needed for a Vanta test
    prevent_destroy = true
  }
}

## ---------------------------------------------------------------------------------------------------------------------
## Cloud SQL Alerts
## ---------------------------------------------------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "db_cpu_too_high" {
  display_name = "Scratch ${local.display_env} DB CPU Utilization too high"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} DB CPU Utilization too high"
    content = "Runbook: ${local.runbook_datastore_alerts}"

  }
  combiner = "OR"
  conditions {
    display_name = "Cloud SQL Database - CPU utilization"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${local.alert_database_id}\" AND metric.type = \"cloudsql.googleapis.com/database/cpu/utilization\""
      threshold_value = "0.95"
      trigger {
        percent = 100
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
  severity              = "CRITICAL"
}

resource "google_monitoring_alert_policy" "db_out_of_disk_space" {
  display_name = "Scratch ${local.display_env} DB low on disk space"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} DB low on disk space"
    content = "Runbook: ${local.runbook_datastore_alerts}"

  }
  combiner = "OR"
  conditions {
    display_name = "Cloud SQL Database - Disk utilization"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${local.alert_database_id}\" AND metric.type = \"cloudsql.googleapis.com/database/disk/utilization\""
      threshold_value = 0.90
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.extended_renotify_interval
    }
  }

  notification_channels = local.warning_notification_channels
  severity              = "WARNING"
}

resource "google_monitoring_alert_policy" "db_disk_read_io_high" {
  display_name = "Scratch ${local.display_env} DB Disk Read I/O above threshold"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} DB Disk Read I/O above threshold"
    content = "Runbook: ${local.runbook_datastore_alerts}"

  }
  combiner = "OR"
  conditions {
    display_name = "Cloud SQL Database - Disk Read I/O"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_RATE"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${local.alert_database_id}\" AND metric.type = \"cloudsql.googleapis.com/database/disk/read_ops_count\""
      threshold_value = var.db_io_read_limit
      trigger {
        count = 5
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
  severity              = "CRITICAL"
}


resource "google_monitoring_alert_policy" "db_disk_write_io_high" {
  display_name = "Scratch ${local.display_env} DB Disk Write I/O above threshold"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} DB Disk Write I/O above threshold"
    content = "Runbook: ${local.runbook_datastore_alerts}"

  }
  combiner = "OR"
  conditions {
    display_name = "Cloud SQL Database - Disk Write I/O"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_RATE"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${local.alert_database_id}\" AND metric.type = \"cloudsql.googleapis.com/database/disk/write_ops_count\""
      threshold_value = var.db_io_write_limit
      trigger {
        count = 5
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
  severity              = "CRITICAL"
}

resource "google_monitoring_alert_policy" "db_mem_usage_too_high" {
  display_name = "Scratch ${local.display_env} DB memory utilization > 95%"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} DB memory utilization > 95%"
    content = "Runbook: ${local.runbook_datastore_alerts}"

  }
  combiner = "OR"
  conditions {
    display_name = "Cloud SQL Database - Memory utilization"
    condition_threshold {
      aggregations {
        alignment_period   = "120s"
        per_series_aligner = "ALIGN_MEAN"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${local.alert_database_id}\" AND metric.type = \"cloudsql.googleapis.com/database/memory/utilization\""
      threshold_value = 0.95
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
  severity              = "CRITICAL"
}


resource "google_monitoring_alert_policy" "db_connections_too_high" {
  display_name = "Scratch ${local.display_env} DB Connections > 95% of max capacity"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} DB Connections > 95% of max capacity"
    content = "Runbook: ${local.runbook_datastore_alerts}"

  }
  combiner = "OR"
  conditions {
    display_name = "Cloud SQL Database - PostgreSQL Connections"
    condition_threshold {
      aggregations {
        alignment_period   = "600s"
        per_series_aligner = "ALIGN_MEAN"
      }
      comparison      = "COMPARISON_GT"
      duration        = "300s"
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${local.alert_database_id}\" AND metric.type = \"cloudsql.googleapis.com/database/postgresql/num_backends\" AND metric.labels.database = \"postgres\""
      threshold_value = local.db_connection_alert_threshold
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
  severity              = "ERROR"
}

## ---------------------------------------------------------------------------------------------------------------------
## Redis Alerts
## ---------------------------------------------------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "redis_mem_usage_too_high" {
  display_name = "Scratch ${local.display_env} Redis using too much Memory"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} Redis using too much Memory"
    content = "Runbook: ${local.runbook_datastore_alerts}"

  }
  combiner = "OR"
  conditions {
    display_name = "Cloud Memorystore Redis Instance - Memory Usage Ratio"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"redis_instance\" AND resource.labels.instance_id = \"${local.alert_redis_id}\" AND metric.type = \"redis.googleapis.com/stats/memory/usage_ratio\""
      threshold_value = 0.95
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
  severity              = "ERROR"
}

## ---------------------------------------------------------------------------------------------------------------------
## Client Service Request Alerts
## ---------------------------------------------------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "client_high_5xx_error_count" {
  display_name = "Scratch ${local.display_env} Client Service - 5xx Errors"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} Client Service - 5xx Errors"
    content = "[Runbook](${local.runbook_cloud_run_service_errors})"
  }
  combiner = "OR"
  conditions {
    display_name = "Client Service Cloud Run - 5xx Mean Request Count"
    condition_threshold {
      aggregations {
        alignment_period   = "600s"
        per_series_aligner = "ALIGN_MEAN"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${google_cloud_run_v2_service.client_service.name}\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      threshold_value = 50
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
  severity              = "ERROR"
}

## ---------------------------------------------------------------------------------------------------------------------
## API Service Alerts
## ---------------------------------------------------------------------------------------------------------------------


resource "google_monitoring_alert_policy" "api_frontend_high_5xx_error_count" {
  display_name = "Scratch ${local.display_env} API Service - 5xx Errors"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} API Service - 5xx Errors"
    content = "Runbook: ${local.runbook_cloud_run_service_errors}"
  }
  combiner = "OR"
  conditions {
    display_name = "API Service Cloud Run - 5xx Request Count"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${google_cloud_run_v2_service.api_service.name}\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      threshold_value = 50
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
  severity              = "ERROR"
}

## ---------------------------------------------------------------------------------------------------------------------
## Cron Service Alerts
## ---------------------------------------------------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "cron_high_5xx_error_count" {
  display_name = "Scratch ${local.display_env} Cron Service - 5xx Errors"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} Cron Service - 5xx Errors"
    content = "Runbook: ${local.runbook_cloud_run_service_errors}"
  }
  combiner = "OR"
  conditions {
    display_name = "Cron Service Cloud Run - 5xx Request Count"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${google_cloud_run_v2_service.cron_service.name}\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      threshold_value = 50
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
  severity              = "ERROR"
}

## ---------------------------------------------------------------------------------------------------------------------
## Worker Service Alerts
## ---------------------------------------------------------------------------------------------------------------------

resource "google_logging_metric" "worker_service_error_count" {
  name   = "worker-service-error-count"
  filter = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${google_cloud_run_v2_service.worker_service.name}\" AND severity >= ERROR"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
  }
  depends_on = [google_project_service.services]
}

resource "google_monitoring_alert_policy" "worker_high_error_log_count" {
  display_name = "Scratch ${local.display_env} Worker Service - High Error Log Count"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} Worker Service - High Error Log Count"
    content = "Runbook: ${local.runbook_cloud_run_service_errors}"
  }
  combiner = "OR"
  conditions {
    display_name = "Worker Service Cloud Run - Error Log Count"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.worker_service_error_count.name}\""
      threshold_value = 10000
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.warning_notification_channels
  severity              = "WARNING"
}

## ---------------------------------------------------------------------------------------------------------------------
## Intrusion detection system notifications (Vanta)
## ---------------------------------------------------------------------------------------------------------------------

resource "google_logging_metric" "intrusion_detection_system_notifications" {
  count  = var.enable_intrusion_detection ? 1 : 0
  name   = "intrusion-detection-metric"
  filter = "logName=\"projects/${var.gcp_project_id}/logs/ids.googleapis.com%2Fthreat\" AND resource.type=\"ids.googleapis.com/Endpoint\" AND jsonPayload.alert_severity=(\"HIGH\" OR \"CRITICAL\")"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "logName"
      value_type  = "STRING"
      description = "The name of the log where the intrusion was detected"
    }
  }

  label_extractors = {
    "logName" = "EXTRACT(logName)"
  }
  depends_on = [google_project_service.services]
}

resource "google_monitoring_alert_policy" "intrusion_detection_system_alert" {
  count        = var.enable_intrusion_detection ? 1 : 0
  display_name = "Scratch ${local.display_env} Intrusion Detection System - Alert"
  documentation {
    subject = "Scratch ${local.display_env} Intrusion Detection System - Alert"
    content = "Runbook: ${local.runbook_flow_log_alerts}"
  }
  combiner = "OR"
  conditions {
    display_name = "Whalesync Vanta - Intrusion Detection System Logs"
    condition_threshold {
      filter     = "resource.type = \"ids.googleapis.com/Endpoint\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.intrusion_detection_system_notifications[0].name}\""
      duration   = "60s"
      comparison = "COMPARISON_GT"

      threshold_value = 1
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
  severity              = "ERROR"

  depends_on = [google_project_service.services]
}

## ---------------------------------------------------------------------------------------------------------------------
## Scratch Git GCE Alerts
## ---------------------------------------------------------------------------------------------------------------------

resource "google_monitoring_alert_policy" "scratch_git_cpu_too_high" {
  display_name = "Scratch ${local.display_env} Scratch Git CPU > 90%"
  count        = var.enable_alerts && var.enable_scratch_git ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} Scratch Git CPU Utilization > 90%"
    content = "Runbook: ${local.runbook_scratch_git_vm}"
  }
  combiner = "OR"
  conditions {
    display_name = "VM Instance - CPU utilization"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"gce_instance\" AND metric.type = \"compute.googleapis.com/instance/cpu/utilization\" AND metric.labels.instance_name = \"${module.scratch_git_gce[0].instance_name}\""
      threshold_value = 0.9
      trigger {
        count = 3
      }
    }
  }
  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }
  notification_channels = local.notification_channels
  severity              = "WARNING"
}

resource "google_monitoring_alert_policy" "scratch_git_memory_too_high" {
  display_name = "Scratch ${local.display_env} Scratch Git Memory > 85%"
  count        = var.enable_alerts && var.enable_scratch_git ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} Scratch Git Memory Utilization > 85%"
    content = "Runbook: ${local.runbook_scratch_git_vm}"
  }
  combiner = "OR"
  conditions {
    display_name = "VM Instance - Memory utilization"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
      comparison      = "COMPARISON_GT"
      duration        = "60s"
      filter          = "resource.type = \"gce_instance\" AND metric.type = \"agent.googleapis.com/memory/percent_used\" AND metric.labels.state = \"used\" AND metadata.system_labels.name = \"${module.scratch_git_gce[0].instance_name}\""
      threshold_value = 85
      trigger {
        count = 1
      }
    }
  }
  conditions {
    display_name = "VM Instance - Memory metric missing"
    condition_absent {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
      duration = "300s"
      filter   = "resource.type = \"gce_instance\" AND metric.type = \"agent.googleapis.com/memory/percent_used\" AND metric.labels.state = \"used\" AND metadata.system_labels.name = \"${module.scratch_git_gce[0].instance_name}\""
      trigger {
        count = 1
      }
    }
  }
  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }
  notification_channels = local.notification_channels
  severity              = "WARNING"
}

resource "google_monitoring_alert_policy" "scratch_git_disk_usage_too_high" {
  display_name = "Scratch ${local.display_env} Scratch Git Disk > 80%"
  count        = var.enable_alerts && var.enable_scratch_git ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} Scratch Git Disk Utilization > 80%"
    content = "Runbook: ${local.runbook_scratch_git_disk}"
  }
  combiner = "OR"
  conditions {
    display_name = "VM Instance - Disk utilization"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
      comparison      = "COMPARISON_GT"
      duration        = "60s"
      filter          = "resource.type = \"gce_instance\" AND metric.type = \"agent.googleapis.com/disk/percent_used\" AND metric.labels.state = \"used\" AND metadata.system_labels.name = \"${module.scratch_git_gce[0].instance_name}\""
      threshold_value = 80
      trigger {
        count = 1
      }
    }
  }
  conditions {
    display_name = "VM Instance - Disk metric missing"
    condition_absent {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
      duration = "300s"
      filter   = "resource.type = \"gce_instance\" AND metric.type = \"agent.googleapis.com/disk/percent_used\" AND metric.labels.state = \"used\" AND metadata.system_labels.name = \"${module.scratch_git_gce[0].instance_name}\""
      trigger {
        count = 1
      }
    }
  }
  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.extended_renotify_interval
    }
  }
  notification_channels = local.notification_channels
  severity              = "WARNING"
}

resource "google_monitoring_alert_policy" "scratch_git_ops_agent_unresponsive" {
  display_name = "Scratch ${local.display_env} Scratch Git Ops Agent unresponsive"
  count        = var.enable_alerts && var.enable_scratch_git ? 1 : 0
  documentation {
    subject = "Scratch ${local.display_env} Scratch Git Ops Agent has not reported for ${var.scratch_git_ops_agent_alert_duration} while the VM is running"
    content = "Runbook: ${local.runbook_scratch_git_vm}"
  }
  combiner = "AND_WITH_MATCHING_RESOURCE"
  severity = "CRITICAL"

  conditions {
    display_name = "VM Instance - Ops Agent uptime metric absent"
    condition_absent {
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
      duration = var.scratch_git_ops_agent_alert_duration
      filter   = "resource.type = \"gce_instance\" AND metric.type = \"agent.googleapis.com/agent/uptime\" AND metadata.system_labels.name = \"${module.scratch_git_gce[0].instance_name}\""
      trigger {
        count = 1
      }
    }
  }

  conditions {
    display_name = "VM Instance - Compute Engine uptime present"
    condition_threshold {
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"gce_instance\" AND metric.type = \"compute.googleapis.com/instance/uptime\" AND metric.labels.instance_name = \"${module.scratch_git_gce[0].instance_name}\""
      threshold_value = 0
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    auto_close = "604800s"
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.notification_channels
}

resource "google_cloud_ids_endpoint" "intrusion_detection_system_endpoint" {
  count      = var.enable_intrusion_detection && var.intrusion_detection_external_url == null ? 1 : 0
  name       = "ids-endpoint"
  location   = var.gcp_zone
  network    = module.vpc.network_id
  severity   = "LOW"
  depends_on = [module.vpc.private_service_connection]
}

resource "google_compute_packet_mirroring" "intrusion_detection_system_packet_mirroring" {
  count       = var.enable_intrusion_detection ? 1 : 0
  name        = "ids-packet-mirroring"
  description = "Packet mirroring for Cloud IDS"
  region      = var.gcp_region
  network {
    url = module.vpc.network_id
  }
  collector_ilb {
    url = var.intrusion_detection_external_url != null ? var.intrusion_detection_external_url : google_cloud_ids_endpoint.intrusion_detection_system_endpoint[0].endpoint_forwarding_rule
  }
  mirrored_resources {
    subnetworks {
      url = module.vpc.subnets_id[0]
    }
  }
  filter {
    ip_protocols = ["tcp"]
    cidr_ranges  = ["0.0.0.0/0"]
    direction    = "BOTH"
  }
  depends_on = [google_project_service.services, module.vpc]
}

## ---------------------------------------------------------------------------------------------------------------------
## VPC Flow Log anomaly detection
## ---------------------------------------------------------------------------------------------------------------------
## Log-based metrics + alerts over VPC Flow Logs, replacing the Cloud IDS endpoint.
## Metrics are gated on var.enable_flow_log_monitoring; alerts additionally honor
## var.enable_alerts. Alerts currently route to warning_notification_channels (Slack +
## email, no PagerDuty) so thresholds can be tuned against real baselines before paging
## on-call.

# (a) Egress to the public internet on a sensitive admin/db/cache port.
resource "google_logging_metric" "flow_log_suspicious_egress_ports" {
  count  = 1
  name   = "flow-log-suspicious-egress-ports"
  filter = "${local.flow_log_external_egress} AND jsonPayload.connection.dest_port=${local.flow_log_suspicious_ports_clause}"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "dest_port"
      value_type  = "STRING"
      description = "Destination port of the suspicious egress flow"
    }
    labels {
      key         = "dest_ip"
      value_type  = "STRING"
      description = "External destination IP"
    }
  }

  label_extractors = {
    "dest_port" = "EXTRACT(jsonPayload.connection.dest_port)"
    "dest_ip"   = "EXTRACT(jsonPayload.connection.dest_ip)"
  }

  depends_on = [google_project_service.services]
}

resource "google_monitoring_alert_policy" "flow_log_suspicious_egress_ports_alert" {
  count        = var.enable_flow_log_monitoring && var.enable_alerts ? 1 : 0
  display_name = "Scratch ${local.display_env} VPC Flow Logs - Suspicious egress port"
  documentation {
    subject = "Scratch ${local.display_env} VPC Flow Logs - Egress to the internet on a sensitive port"
    content = <<-EOF
    A workload made an outbound connection to the public internet on a port that should never leave the VPC (SSH/Telnet/SMB/MySQL/Redis/RDP/MongoDB). This can indicate compromise, exfiltration, or misconfiguration. Investigate the source instance and destination IP.
    Runbook: ${local.runbook_flow_log_alerts}
    EOF
  }
  combiner = "OR"
  conditions {
    display_name = "Suspicious egress port flow count"
    condition_threshold {
      filter          = "resource.type = \"gce_subnetwork\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.flow_log_suspicious_egress_ports[0].name}\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      trigger {
        count = 1
      }
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  alert_strategy {
    # Security signals fire on a windowed count of discrete events, so the condition
    # clears on its own within minutes. Pin auto_close to the GCP maximum (7 days) so an
    # incident stays open for a human to triage instead of self-resolving. GCP does not
    # allow disabling auto_close; 604800s is the longest it permits.
    auto_close = "604800s"
    notification_channel_strategy {
      renotify_interval = local.extended_renotify_interval
    }
  }

  notification_channels = local.warning_notification_channels
  severity              = "WARNING"
  depends_on            = [google_logging_metric.flow_log_suspicious_egress_ports]
}

# (b) Traffic to/from a country outside the allowlist (either end resolves to a
# non-allowlisted country). Geo fields only populate for public IPs, so internal traffic
# is naturally excluded.
resource "google_logging_metric" "flow_log_unexpected_country" {
  count  = 1
  name   = "flow-log-unexpected-country"
  filter = "${local.flow_log_base_filter} AND ((jsonPayload.dest_location.country:* AND NOT jsonPayload.dest_location.country=${local.flow_log_allowed_countries_clause}) OR (jsonPayload.src_location.country:* AND NOT jsonPayload.src_location.country=${local.flow_log_allowed_countries_clause}))"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    labels {
      key         = "dest_country"
      value_type  = "STRING"
      description = "Destination country code"
    }
    labels {
      key         = "src_country"
      value_type  = "STRING"
      description = "Source country code"
    }
  }

  label_extractors = {
    "dest_country" = "EXTRACT(jsonPayload.dest_location.country)"
    "src_country"  = "EXTRACT(jsonPayload.src_location.country)"
  }

  depends_on = [google_project_service.services]
}

resource "google_monitoring_alert_policy" "flow_log_unexpected_country_alert" {
  count        = var.enable_flow_log_monitoring && var.enable_alerts ? 1 : 0
  display_name = "Scratch ${local.display_env} VPC Flow Logs - Unexpected geo-location"
  documentation {
    subject = "Scratch ${local.display_env} VPC Flow Logs - Traffic to/from an unexpected country"
    content = <<-EOF
    VPC traffic was observed to or from a country outside the expected allowlist. This can indicate access from an unexpected location or egress to an unexpected destination. Investigate the source/destination IPs and countries.
    Runbook: ${local.runbook_flow_log_alerts}
    EOF
  }
  combiner = "OR"
  conditions {
    display_name = "Unexpected-country flow count"
    condition_threshold {
      filter          = "resource.type = \"gce_subnetwork\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.flow_log_unexpected_country[0].name}\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      trigger {
        count = 1
      }
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
    }
  }

  alert_strategy {
    # See note on auto_close in flow_log_suspicious_egress_ports_alert: pin to the GCP
    # max (7 days) so a security incident does not self-resolve before a human triages.
    auto_close = "604800s"
    notification_channel_strategy {
      renotify_interval = local.extended_renotify_interval
    }
  }

  notification_channels = local.warning_notification_channels
  severity              = "WARNING"
  depends_on            = [google_logging_metric.flow_log_unexpected_country]
}

# (c) Sudden egress volume spike to external destinations. Distribution metric over
# bytes_sent (the one metric that needs a value_extractor).
resource "google_logging_metric" "flow_log_external_egress_bytes" {
  count           = 1
  name            = "flow-log-external-egress-bytes"
  filter          = "${local.flow_log_external_egress} AND jsonPayload.bytes_sent>0"
  value_extractor = "EXTRACT(jsonPayload.bytes_sent)"
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "By"
    labels {
      key         = "src_ip"
      value_type  = "STRING"
      description = "Source IP of the egress flow"
    }
    labels {
      key         = "src_instance"
      value_type  = "STRING"
      description = "Source VM instance name"
    }
  }

  label_extractors = {
    # Label on the source (a small, stable set) rather than dest_ip, which is unbounded
    # over external destinations and would blow up metric cardinality.
    "src_ip"       = "EXTRACT(jsonPayload.connection.src_ip)"
    "src_instance" = "EXTRACT(jsonPayload.src_instance.vm_name)"
  }

  bucket_options {
    exponential_buckets {
      num_finite_buckets = 64
      growth_factor      = 2
      scale              = 1
    }
  }

  depends_on = [google_project_service.services]
}

resource "google_monitoring_alert_policy" "flow_log_external_egress_spike_alert" {
  count        = var.enable_flow_log_monitoring && var.enable_alerts ? 1 : 0
  display_name = "Scratch ${local.display_env} VPC Flow Logs - External egress volume spike"
  documentation {
    subject = "Scratch ${local.display_env} VPC Flow Logs - Unusually high egress to the public internet"
    content = <<-EOF
    A single flow egressing the VPC to a public internet destination was unusually large (p99 flow size over the alert window exceeded the configured threshold). This can indicate data exfiltration. Investigate the source instances and destination IPs.
    Runbook: ${local.runbook_flow_log_alerts}
    EOF
  }
  combiner = "OR"
  conditions {
    display_name = "External egress flow size (p99) over window"
    condition_threshold {
      filter          = "resource.type = \"gce_subnetwork\" AND metric.type = \"logging.googleapis.com/user/${google_logging_metric.flow_log_external_egress_bytes[0].name}\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = local.flow_log_egress_byte_spike_threshold
      trigger {
        count = 1
      }
      aggregations {
        # A DISTRIBUTION metric must be aligned to a scalar (percentile) before it can be
        # compared to a numeric threshold; REDUCE_MAX surfaces the worst subnet.
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_PERCENTILE_99"
        cross_series_reducer = "REDUCE_MAX"
      }
    }
  }

  alert_strategy {
    # See note on auto_close in flow_log_suspicious_egress_ports_alert: pin to the GCP
    # max (7 days) so a security incident does not self-resolve before a human triages.
    auto_close = "604800s"
    notification_channel_strategy {
      renotify_interval = local.extended_renotify_interval
    }
  }

  notification_channels = local.warning_notification_channels
  severity              = "WARNING"
  depends_on            = [google_logging_metric.flow_log_external_egress_bytes]
}

## ---------------------------------------------------------------------------------------------------------------------
## Desktop / CLI download health (DEV-11324)
## ---------------------------------------------------------------------------------------------------------------------
## The public downloads page (client/src/app/downloads) reads GET /desktop-release/{latest,cli/latest} from our own
## server, which resolves the newest matching GitHub release from whalesync/{scratch-desktop,scratch-cli}. A plain
## HTTP-200 uptime check is INSUFFICIENT: when the newest release is missing per-platform installers the endpoint still
## returns 200 with an assets array that has no .dmg/.exe/.AppImage|.deb, and the page renders an empty download area
## with no error. So we content-match the response body to assert the per-platform download assets are present. A 404
## (no matching release at all) also fails the check via the 2xx status assertion.
##
## IMPORTANT: Cloud Monitoring currently allows only ONE content_matcher per uptime check, so we cannot assert all
## three platform installers in a single check. Instead we run one check per (surface, platform) installer pattern via
## for_each. This is more faithful anyway: it independently catches a *partial* release (e.g. the macOS-only release
## that shipped once as v1.0.49, which is exactly why scratch-desktop/scripts/finalize_release.sh's installer gate
## exists). The regexes mirror that finalize gate and the client-side asset grouping in downloads/page.tsx.
##
## We check two sources:
##   1. Our own server endpoints (300s cadence) — exactly what the downloads page consumes.
##   2. The public GitHub release endpoints directly (900s cadence, anonymous — ~4 req/hr/region across the uptime
##      prober regions, well under GitHub's 60 req/hr/IP anonymous limit). This bypasses the server's 30-day
##      last-known-good cache, so a GitHub outage or a malformed newest release is caught even while our cached server
##      response stays green.
## Runbook: local.runbook_desktop_release.

locals {
  # One entry per platform installer pattern. Shared between the server-endpoint checks and the GitHub-source checks
  # (only the host/path differ, which are set on each resource). regex is RE2; backslashes are doubled for HCL.
  desktop_installer_checks = {
    "desktop-macos"   = { label = "desktop macOS installer (.dmg)", regex = "\\.dmg" }
    "desktop-windows" = { label = "desktop Windows installer (.exe)", regex = "\\.exe" }
    "desktop-linux"   = { label = "desktop Linux installer (.AppImage/.deb)", regex = "\\.(AppImage|deb)" }
  }
  cli_installer_checks = {
    "cli-darwin"  = { label = "CLI macOS archive (scratchmd_darwin_)", regex = "scratchmd_darwin_" }
    "cli-windows" = { label = "CLI Windows archive (scratchmd_windows_)", regex = "scratchmd_windows_" }
    "cli-linux"   = { label = "CLI Linux archive (scratchmd_linux_)", regex = "scratchmd_linux_" }
  }
}

# --- 1. Server endpoint: desktop app installers (one check per platform) ---
resource "google_monitoring_uptime_check_config" "desktop_download_server" {
  for_each     = var.enable_desktop_release_monitoring ? local.desktop_installer_checks : {}
  display_name = "Scratch ${local.display_env} Download server - ${each.value.label} present"
  timeout      = "10s"
  period       = "300s"

  http_check {
    request_method = "GET"
    path           = "/desktop-release/latest"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.gcp_project_id
      host       = var.api_domain
    }
  }

  content_matchers {
    content = each.value.regex
    matcher = "MATCHES_REGEX"
  }
}

# --- 2. Server endpoint: scratchmd CLI archives (one check per platform) ---
resource "google_monitoring_uptime_check_config" "cli_download_server" {
  for_each     = var.enable_desktop_release_monitoring ? local.cli_installer_checks : {}
  display_name = "Scratch ${local.display_env} Download server - ${each.value.label} present"
  timeout      = "10s"
  period       = "300s"

  http_check {
    request_method = "GET"
    path           = "/desktop-release/cli/latest"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.gcp_project_id
      host       = var.api_domain
    }
  }

  content_matchers {
    content = each.value.regex
    matcher = "MATCHES_REGEX"
  }
}

# --- 3. GitHub source: desktop app releases/latest (bypasses our server cache) ---
resource "google_monitoring_uptime_check_config" "github_desktop_release" {
  for_each     = var.enable_github_release_monitoring ? local.desktop_installer_checks : {}
  display_name = "Scratch ${local.display_env} Download GitHub - scratch-desktop ${each.value.label} present"
  timeout      = "10s"
  period       = "900s"

  http_check {
    request_method = "GET"
    path           = "/repos/whalesync/scratch-desktop/releases/latest"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.gcp_project_id
      host       = "api.github.com"
    }
  }

  content_matchers {
    content = each.value.regex
    matcher = "MATCHES_REGEX"
  }
}

# --- 4. GitHub source: scratchmd CLI releases/latest (separate repo, bypasses our server cache) ---
resource "google_monitoring_uptime_check_config" "github_cli_release" {
  for_each     = var.enable_github_release_monitoring ? local.cli_installer_checks : {}
  display_name = "Scratch ${local.display_env} Download GitHub - scratch-cli ${each.value.label} present"
  timeout      = "10s"
  period       = "900s"

  http_check {
    request_method = "GET"
    path           = "/repos/whalesync/scratch-cli/releases/latest"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.gcp_project_id
      host       = "api.github.com"
    }
  }

  content_matchers {
    content = each.value.regex
    matcher = "MATCHES_REGEX"
  }
}

# --- 5. GitHub source: the releases HTML page renders (belt-and-suspenders availability of the GitHub UI) ---
resource "google_monitoring_uptime_check_config" "github_desktop_releases_page" {
  count        = var.enable_github_release_monitoring ? 1 : 0
  display_name = "Scratch ${local.display_env} Desktop Release - GitHub releases page loads"
  timeout      = "10s"
  period       = "900s"

  http_check {
    request_method = "GET"
    path           = "/whalesync/scratch-desktop/releases"
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.gcp_project_id
      host       = "github.com"
    }
  }

  # The repo path is in the <title> near the top of the server-rendered HTML, inside the body-inspection window.
  content_matchers {
    content = "whalesync/scratch-desktop"
    matcher = "CONTAINS_STRING"
  }
}

## The alert policies below fire on the uptime_check/check_passed metric. Each condition pins one check via
## metric.label.check_id, aligns each region's latest sample (ALIGN_NEXT_OLDER) and counts how many regions report
## FALSE (REDUCE_COUNT_FALSE); COMPARISON_GT threshold_value = 1 fires only when >= 2 regions fail, ignoring a
## single-region blip. Warn tier (email + Slack #feed-gcp-alerts, no page), matching the flow-log "tune before paging"
## philosophy — escalation to page is a two-line swap documented in the runbook. One policy per surface keeps the Slack
## alert name specific and stays well under the 6-conditions-per-policy limit.

# --- Alert A: desktop app, our server endpoint ---
resource "google_monitoring_alert_policy" "scratch_desktop_download_server_broken" {
  count        = var.enable_desktop_release_monitoring && var.enable_alerts ? 1 : 0
  display_name = "Scratch ${local.display_env} Download - desktop server endpoint broken"
  documentation {
    subject = "Scratch ${local.display_env} Download - /desktop-release/latest is missing a platform installer"
    content = <<-EOF
    The public desktop download endpoint failed its uptime check: it did not return 2xx, or its JSON body is missing a
    required per-platform installer (macOS .dmg, Windows .exe, Linux .AppImage/.deb). The condition name identifies the
    missing platform. ${var.client_domain}/downloads renders an empty or partial download area in this state. If this
    fires but the GitHub-source alert does not, suspect our own server/cache rather than the release itself.
    Confirm: curl -s https://${var.api_domain}/desktop-release/latest | jq '.assets[].name'
    Runbook: ${local.runbook_desktop_release}
    EOF
  }
  combiner = "OR"
  dynamic "conditions" {
    for_each = google_monitoring_uptime_check_config.desktop_download_server
    content {
      display_name = "Missing ${conditions.key} from multiple regions"
      condition_threshold {
        filter = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id = \"${conditions.value.uptime_check_id}\""
        aggregations {
          alignment_period     = "600s"
          per_series_aligner   = "ALIGN_NEXT_OLDER"
          cross_series_reducer = "REDUCE_COUNT_FALSE"
          group_by_fields      = ["resource.label.project_id", "resource.label.host"]
        }
        comparison      = "COMPARISON_GT"
        threshold_value = 1
        duration        = "300s"
        trigger {
          count = 1
        }
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.warning_notification_channels
  severity              = "WARNING"
}

# --- Alert B: scratchmd CLI, our server endpoint ---
resource "google_monitoring_alert_policy" "scratch_cli_download_server_broken" {
  count        = var.enable_desktop_release_monitoring && var.enable_alerts ? 1 : 0
  display_name = "Scratch ${local.display_env} Download - CLI server endpoint broken"
  documentation {
    subject = "Scratch ${local.display_env} Download - /desktop-release/cli/latest is missing a platform archive"
    content = <<-EOF
    The public scratchmd CLI download endpoint failed its uptime check: it did not return 2xx, or its JSON body is
    missing a required per-platform archive (scratchmd_darwin_/_windows_/_linux_). The condition name identifies the
    missing platform. If this fires but the GitHub-source alert does not, suspect our own server/cache.
    Confirm: curl -s https://${var.api_domain}/desktop-release/cli/latest | jq '.assets[].name'
    Runbook: ${local.runbook_desktop_release}
    EOF
  }
  combiner = "OR"
  dynamic "conditions" {
    for_each = google_monitoring_uptime_check_config.cli_download_server
    content {
      display_name = "Missing ${conditions.key} from multiple regions"
      condition_threshold {
        filter = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id = \"${conditions.value.uptime_check_id}\""
        aggregations {
          alignment_period     = "600s"
          per_series_aligner   = "ALIGN_NEXT_OLDER"
          cross_series_reducer = "REDUCE_COUNT_FALSE"
          group_by_fields      = ["resource.label.project_id", "resource.label.host"]
        }
        comparison      = "COMPARISON_GT"
        threshold_value = 1
        duration        = "300s"
        trigger {
          count = 1
        }
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.warning_notification_channels
  severity              = "WARNING"
}

# --- Alert C: desktop app, GitHub release source ---
resource "google_monitoring_alert_policy" "github_desktop_release_source_broken" {
  count        = var.enable_github_release_monitoring && var.enable_alerts ? 1 : 0
  display_name = "Scratch ${local.display_env} Download - GitHub desktop release source broken"
  documentation {
    subject = "Scratch ${local.display_env} Download - GitHub scratch-desktop release is unreachable or missing an installer"
    content = <<-EOF
    A direct uptime check against the public GitHub scratch-desktop release source failed: GitHub did not return 2xx
    (possible GitHub outage), or the latest release is missing a required per-platform installer. The condition name
    identifies the missing platform. This bypasses our server's 30-day last-known-good cache, so it can fire while the
    server endpoint alert stays green (users may still get the cached-good release, but the newest one is bad or GitHub
    is down). GitHub anonymous rate limits are the main false-alarm source — see runbook.
    Confirm: curl -s https://api.github.com/repos/whalesync/scratch-desktop/releases/latest | jq '.assets[].name'
    Runbook: ${local.runbook_desktop_release}
    EOF
  }
  combiner = "OR"
  dynamic "conditions" {
    for_each = google_monitoring_uptime_check_config.github_desktop_release
    content {
      display_name = "Missing ${conditions.key} from multiple regions"
      condition_threshold {
        filter = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id = \"${conditions.value.uptime_check_id}\""
        aggregations {
          alignment_period     = "1800s"
          per_series_aligner   = "ALIGN_NEXT_OLDER"
          cross_series_reducer = "REDUCE_COUNT_FALSE"
          group_by_fields      = ["resource.label.project_id", "resource.label.host"]
        }
        comparison      = "COMPARISON_GT"
        threshold_value = 1
        duration        = "600s"
        trigger {
          count = 1
        }
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.warning_notification_channels
  severity              = "WARNING"
}

# --- Alert D: scratchmd CLI, GitHub release source ---
resource "google_monitoring_alert_policy" "github_cli_release_source_broken" {
  count        = var.enable_github_release_monitoring && var.enable_alerts ? 1 : 0
  display_name = "Scratch ${local.display_env} Download - GitHub CLI release source broken"
  documentation {
    subject = "Scratch ${local.display_env} Download - GitHub scratch-cli release is unreachable or missing an archive"
    content = <<-EOF
    A direct uptime check against the public GitHub scratch-cli release source failed: GitHub did not return 2xx
    (possible GitHub outage), or the latest release is missing a required per-platform archive
    (scratchmd_darwin_/_windows_/_linux_). The condition name identifies the missing platform. This bypasses our
    server's cache. GitHub anonymous rate limits are the main false-alarm source — see runbook.
    Confirm: curl -s https://api.github.com/repos/whalesync/scratch-cli/releases/latest | jq '.assets[].name'
    Runbook: ${local.runbook_desktop_release}
    EOF
  }
  combiner = "OR"
  dynamic "conditions" {
    for_each = google_monitoring_uptime_check_config.github_cli_release
    content {
      display_name = "Missing ${conditions.key} from multiple regions"
      condition_threshold {
        filter = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id = \"${conditions.value.uptime_check_id}\""
        aggregations {
          alignment_period     = "1800s"
          per_series_aligner   = "ALIGN_NEXT_OLDER"
          cross_series_reducer = "REDUCE_COUNT_FALSE"
          group_by_fields      = ["resource.label.project_id", "resource.label.host"]
        }
        comparison      = "COMPARISON_GT"
        threshold_value = 1
        duration        = "600s"
        trigger {
          count = 1
        }
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.warning_notification_channels
  severity              = "WARNING"
}

# --- Alert E: the GitHub releases HTML page loads ---
resource "google_monitoring_alert_policy" "github_releases_page_broken" {
  count        = var.enable_github_release_monitoring && var.enable_alerts ? 1 : 0
  display_name = "Scratch ${local.display_env} Download - GitHub releases page not loading"
  documentation {
    subject = "Scratch ${local.display_env} Download - GitHub scratch-desktop releases page failed to load"
    content = <<-EOF
    The public GitHub releases page (github.com/whalesync/scratch-desktop/releases) — the downloads page's "Browse all
    releases" fallback — failed its uptime check (non-2xx or the expected content was absent). Usually a GitHub outage.
    Runbook: ${local.runbook_desktop_release}
    EOF
  }
  combiner = "OR"
  conditions {
    display_name = "GitHub releases page failing from multiple regions"
    condition_threshold {
      filter = "resource.type = \"uptime_url\" AND metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id = \"${google_monitoring_uptime_check_config.github_desktop_releases_page[0].uptime_check_id}\""
      aggregations {
        alignment_period     = "1800s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.project_id", "resource.label.host"]
      }
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      trigger {
        count = 1
      }
    }
  }

  alert_strategy {
    notification_channel_strategy {
      renotify_interval = local.renotify_interval
    }
  }

  notification_channels = local.warning_notification_channels
  severity              = "WARNING"
}
