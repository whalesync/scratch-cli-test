/**
  * Cloud SQL Module
  *
  * Defaults to disk autoresizing
  * Defaults to an SSD disk
  * Defaults to Enterprise edition (as opposed to Enterprise Plus)
*/

resource "google_sql_database_instance" "primary" {
  region           = var.region
  database_version = var.database_version

  // Add a random element to name as names are not reusable for 2 weeks
  name = "${var.name}-${random_id.db_name_suffix.hex}"

  # NOTE: This attribute is ignored by ignored_changes below to avoid it being changed when we rotate the secret
  root_password = var.password

  deletion_protection = true

  settings {
    availability_type = var.high_availability ? "REGIONAL" : "ZONAL"
    tier              = var.tier
    edition           = "ENTERPRISE"
    disk_size         = var.disk_size
    user_labels       = var.labels

    # Expose through a private IP address
    ip_configuration {
      ipv4_enabled    = false
      private_network = var.private_network_id

      # This combo ensures that SSL is required to communicate with the DB but no client certificates are verified
      # See https://cloud.google.com/sql/docs/mysql/admin-api/rest/v1/instances#SslMode
      ssl_mode = "ENCRYPTED_ONLY"

      enable_private_path_for_google_cloud_services = true
    }

    location_preference {
      zone           = var.primary_zone
      secondary_zone = var.secondary_zone
    }

    maintenance_window {
      day          = var.maintenance_day
      hour         = var.maintenance_hour
      update_track = "stable"
    }

    backup_configuration {
      enabled    = var.backup_enabled
      start_time = var.backup_start_time
      backup_retention_settings {
        retained_backups = 14
        retention_unit   = "COUNT"
      }

      # PITR is really bad for performance given the massive # of writes whalesync does, do not enable this
      point_in_time_recovery_enabled = false
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 2048
      record_application_tags = true
      record_client_address   = true
    }

    database_flags {
      name  = "cloudsql.enable_pgaudit"
      value = "on"
    }

    database_flags {
      name  = "pgaudit.log"
      value = "role,ddl"
    }

    database_flags {
      name  = "log_disconnections"
      value = "on"
    }

    database_flags {
      name  = "log_connections"
      value = "on"
    }

    database_flags {
      name  = "log_checkpoints"
      value = "on"
    }

    database_flags {
      name  = "log_lock_waits"
      value = "on"
    }

    database_flags {
      name  = "log_min_duration_statement"
      value = "5000"
    }
  }

  lifecycle {
    ignore_changes = [root_password]
  }

  # Make sure terraform's default timeouts don't break slow operations
  timeouts {
    create = "60m"
    update = "60m"
  }
}

resource "random_id" "db_name_suffix" {
  byte_length = 4
}

## ---------------------------------------------------------------------------------------------------------------------
## Read-Only User
## ---------------------------------------------------------------------------------------------------------------------

resource "random_password" "readonly_password" {
  length  = 24
  special = false
}

resource "google_sql_user" "readonly" {
  name     = "readonly"
  instance = google_sql_database_instance.primary.name
  password = random_password.readonly_password.result
}

