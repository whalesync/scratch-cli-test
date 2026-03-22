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
  ])
  alert_database_id             = "${var.gcp_project_id}:${module.db_primary.instance_id}"
  db_connection_alert_threshold = var.db_connection_limit * 0.95
  alert_redis_id                = "projects/${var.gcp_project_id}/locations/${var.gcp_region}/instances/${local.redis_name}"
  playbook_link                 = "https://www.notion.so/whalesync/Playbook-Firefighing-and-On-Call-GCP-c1914705f4ed45eba45d6c92e786ddfa?pvs=4"
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
  display_name = "${local.display_env} CloudSQL Proxy CPU > 80%"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} CloudSQL Proxy CPU Utilization > 80%"
    content = "Ops Playbook: ${local.playbook_link}"
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
  display_name = "${local.display_env} DB CPU Utilization too high"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} DB CPU Utilization too high"
    content = "Ops Playbook: ${local.playbook_link}"

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
  display_name = "${local.display_env} DB low on disk space"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} DB low on disk space"
    content = "Ops Playbook: ${local.playbook_link}"

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
  display_name = "${local.display_env} DB Disk Read I/O above threshold"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} DB Disk Read I/O above threshold"
    content = "Ops Playbook: ${local.playbook_link}"

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
  display_name = "${local.display_env} DB Disk Write I/O above threshold"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} DB Disk Write I/O above threshold"
    content = "Ops Playbook: ${local.playbook_link}"

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
  display_name = "${local.display_env} DB memory utilization > 95%"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} DB memory utilization > 95%"
    content = "Ops Playbook: ${local.playbook_link}"

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
  display_name = "${local.display_env} DB Connections > 95% of max capacity"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} DB Connections > 95% of max capacity"
    content = "Ops Playbook: ${local.playbook_link}"

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
  display_name = "${local.display_env} Redis using too much Memory"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} Redis using too much Memory"
    content = "Ops Playbook: ${local.playbook_link}"

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
  display_name = "${local.display_env} Client Service - 5xx Errors"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} Client Service - 5xx Errors"
    content = "[Remediation Playbook](https://www.notion.so/whalesync/Playbook-Firefighting-and-On-Call-c1914705f4ed45eba45d6c92e786ddfa?pvs=4#d58b6663c58346058b8157bc9caf8919)"
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
  display_name = "${local.display_env} API Service - 5xx Errors"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} API Service - 5xx Errors"
    content = "Ops Playbook: ${local.playbook_link}"
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
  display_name = "${local.display_env} Cron Service - 5xx Errors"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} Cron Service - 5xx Errors"
    content = "Ops Playbook: ${local.playbook_link}"
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
  display_name = "${local.display_env} Worker Service - High Error Log Count"
  count        = var.enable_alerts ? 1 : 0
  documentation {
    subject = "${local.display_env} Worker Service - High Error Log Count"
    content = "Ops Playbook: ${local.playbook_link}"
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
  display_name = "${local.display_env} Intrusion Detection System - Alert"
  documentation {
    subject = "${local.display_env} Intrusion Detection System - Alert"
    content = "Ops Playbook: ${local.playbook_link}"
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
  display_name = "${local.display_env} Scratch Git CPU > 90%"
  count        = var.enable_alerts && var.enable_scratch_git ? 1 : 0
  documentation {
    subject = "${local.display_env} Scratch Git CPU Utilization > 90%"
    content = "Ops Playbook: ${local.playbook_link}"
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
  display_name = "${local.display_env} Scratch Git Memory > 85%"
  count        = var.enable_alerts && var.enable_scratch_git ? 1 : 0
  documentation {
    subject = "${local.display_env} Scratch Git Memory Utilization > 85%"
    content = "Ops Playbook: ${local.playbook_link}"
  }
  combiner = "OR"
  conditions {
    display_name = "VM Instance - Memory utilization"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"gce_instance\" AND metric.type = \"agent.googleapis.com/memory/percent_used\" AND metadata.system_labels.name = \"${module.scratch_git_gce[0].instance_name}\""
      threshold_value = 85
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
  notification_channels = local.warning_notification_channels
  severity              = "WARNING"
}

resource "google_monitoring_alert_policy" "scratch_git_disk_usage_too_high" {
  display_name = "${local.display_env} Scratch Git Disk > 80%"
  count        = var.enable_alerts && var.enable_scratch_git ? 1 : 0
  documentation {
    subject = "${local.display_env} Scratch Git Disk Utilization > 80%"
    content = "Ops Playbook: ${local.playbook_link}"
  }
  combiner = "OR"
  conditions {
    display_name = "VM Instance - Disk utilization"
    condition_threshold {
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
      comparison      = "COMPARISON_GT"
      duration        = "0s"
      filter          = "resource.type = \"gce_instance\" AND metric.type = \"agent.googleapis.com/disk/percent_used\" AND metadata.system_labels.name = \"${module.scratch_git_gce[0].instance_name}\" AND metric.labels.device = starts_with(\"/dev/disk\")"
      threshold_value = 80
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
