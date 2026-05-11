/**
  * Scratch Git Module
  *
  * Provisions a GCE instance running the scratch-git Docker image on Debian 12
  * with a persistent data disk. Accessible within the VPC to CloudRun services and the SQL Proxy VM.
*/

## ---------------------------------------------------------------------------------------------------------------------
## Secret Access — allow the scratch-git service account to read the Slack webhook URL at runtime
## ---------------------------------------------------------------------------------------------------------------------

resource "google_secret_manager_secret_iam_member" "slack_notification_webhook_url" {
  project   = var.gcp_project_id
  secret_id = "SLACK_NOTIFICATION_WEBHOOK_URL"
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${var.service_account_email}"
}

## ---------------------------------------------------------------------------------------------------------------------
## Persistent Data Disk
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_disk" "data" {
  name     = "${var.instance_name}-data"
  type     = var.disk_type
  zone     = var.zone
  size     = var.disk_size_gb
  project  = var.gcp_project_id
  snapshot = var.disk_source_snapshot

  labels = merge(var.labels, {
    "service" = "scratch-git"
  })
}

## ---------------------------------------------------------------------------------------------------------------------
## Disk Snapshot Schedule
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_resource_policy" "snapshot_schedule" {
  count = var.snapshot_schedule_enabled ? 1 : 0

  name    = "${var.instance_name}-data-snapshot-schedule"
  project = var.gcp_project_id
  region  = var.region

  snapshot_schedule_policy {
    schedule {
      hourly_schedule {
        hours_in_cycle = var.snapshot_hours_in_cycle
        start_time     = var.snapshot_start_time
      }
    }

    retention_policy {
      max_retention_days    = var.snapshot_retention_days
      on_source_disk_delete = "KEEP_AUTO_SNAPSHOTS"
    }

    snapshot_properties {
      labels = merge(var.labels, {
        "service" = "scratch-git"
        "type"    = "automated-backup"
      })
      storage_locations = [var.region]
    }
  }
}

resource "google_compute_disk_resource_policy_attachment" "snapshot_attachment" {
  count = var.snapshot_schedule_enabled ? 1 : 0

  name    = google_compute_resource_policy.snapshot_schedule[0].name
  disk    = google_compute_disk.data.name
  zone    = var.zone
  project = var.gcp_project_id
}

## ---------------------------------------------------------------------------------------------------------------------
## Static Internal IP
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_address" "internal" {
  name         = "${var.instance_name}-internal-ip"
  project      = var.gcp_project_id
  region       = var.region
  address_type = "INTERNAL"
  subnetwork   = var.subnetwork
}

## ---------------------------------------------------------------------------------------------------------------------
## GCE Instance (Debian 12)
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_instance" "scratch_git" {
  name         = var.instance_name
  machine_type = var.machine_type
  zone         = var.zone
  project      = var.gcp_project_id

  deletion_protection = false

  tags = ["scratch-git"]

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = var.boot_disk_size_gb
    }
  }

  attached_disk {
    source      = google_compute_disk.data.self_link
    device_name = "data-disk"
    mode        = "READ_WRITE"
  }

  network_interface {
    network    = var.network
    subnetwork = var.subnetwork
    # No network_ip — instance gets ephemeral internal IP
    # The stable IP is now the LB VIP on the forwarding rule
    # No access_config — internal VPC access only
  }

  service_account {
    email  = var.service_account_email
    scopes = ["cloud-platform"]
  }

  allow_stopping_for_update = true

  metadata = {
    block-project-ssh-keys = "true"
    enable-oslogin         = "TRUE"
  }

  metadata_startup_script = <<-EOT
    #!/bin/bash
    set -eo pipefail

    # --- Terraform-injected variables ---
    DEVICE="/dev/disk/by-id/google-data-disk"
    MOUNT_POINT="/mnt/disks/data"
    DEPLOY_DIR="$MOUNT_POINT/.deploy"
    STATE_FILE="$MOUNT_POINT/.active-slot"
    IMAGE="${var.docker_image}"
    REGISTRY_HOST="${split("/", var.docker_image)[0]}"
    INITIALIZE_FILESYSTEM="${var.initialize_filesystem}"
    GCP_PROJECT_ID="${var.gcp_project_id}"
    DEPLOY_SCRIPT=$(cat <<'DEPLOY_HEREDOC'
    ${file("${path.module}/scripts/deploy.sh")}
    DEPLOY_HEREDOC
    )

    # --- Main startup logic ---
    ${file("${path.module}/scripts/startup.sh")}
  EOT

  # Enable Shielded VM
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  lifecycle {
    ignore_changes       = [metadata["ssh-keys"]]
    replace_triggered_by = [google_compute_disk.data.id]
  }
}

## ---------------------------------------------------------------------------------------------------------------------
## Health Check
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_health_check" "scratch_git" {
  name    = "${var.instance_name}-health-check"
  project = var.gcp_project_id

  timeout_sec         = 5
  check_interval_sec  = 10
  healthy_threshold   = 2
  unhealthy_threshold = 3

  tcp_health_check {
    port = 3100
  }
}

## ---------------------------------------------------------------------------------------------------------------------
## Unmanaged Instance Group
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_instance_group" "scratch_git" {
  name    = "${var.instance_name}-instance-group"
  project = var.gcp_project_id
  zone    = var.zone
  network = var.network

  named_port {
    name = "git-scratch-api"
    port = 3100
  }

  named_port {
    name = "git-http-backend"
    port = 3101
  }
}

resource "google_compute_instance_group_membership" "scratch_git" {
  instance_group = google_compute_instance_group.scratch_git.name
  instance       = google_compute_instance.scratch_git.self_link
  zone           = var.zone
  project        = var.gcp_project_id
}

## ---------------------------------------------------------------------------------------------------------------------
## Regional Backend Service (Internal TCP)
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_region_backend_service" "scratch_git" {
  name                  = "${var.instance_name}-backend-service"
  project               = var.gcp_project_id
  region                = var.region
  protocol              = "TCP"
  load_balancing_scheme = "INTERNAL"
  health_checks         = [google_compute_health_check.scratch_git.id]

  backend {
    group          = google_compute_instance_group.scratch_git.self_link
    balancing_mode = "CONNECTION"
  }
}

## ---------------------------------------------------------------------------------------------------------------------
## Internal Forwarding Rule (LB VIP)
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_forwarding_rule" "scratch_git" {
  provider = google.no_labels

  name                  = "${var.instance_name}-forwarding-rule"
  project               = var.gcp_project_id
  region                = var.region
  load_balancing_scheme = "INTERNAL"
  backend_service       = google_compute_region_backend_service.scratch_git.id
  ip_address            = google_compute_address.internal.address
  ip_protocol           = "TCP"
  ports                 = ["3100", "3101"]
  network               = var.network
  subnetwork            = var.subnetwork
}

## ---------------------------------------------------------------------------------------------------------------------
## Firewall Rule — Allow VPC traffic to scratch-git on ports 3100 and 3101
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_firewall" "allow_scratch_git" {
  name    = "${var.network_name}-allow-scratch-git"
  project = var.gcp_project_id
  network = var.network

  allow {
    protocol = "tcp"
    ports    = ["3100", "3101"]
  }

  source_ranges = var.vpc_cidr_ranges
  target_tags   = ["scratch-git"]
}

## ---------------------------------------------------------------------------------------------------------------------
## Firewall Rule — Allow GCP health check probes
## ---------------------------------------------------------------------------------------------------------------------

resource "google_compute_firewall" "allow_health_check" {
  name    = "${var.network_name}-allow-scratch-git-health-check"
  project = var.gcp_project_id
  network = var.network

  allow {
    protocol = "tcp"
    ports    = ["3100"]
  }

  source_ranges = ["35.191.0.0/16", "130.211.0.0/22"]
  target_tags   = ["scratch-git"]
}
