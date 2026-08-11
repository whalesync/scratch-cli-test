resource "google_service_account" "default" {
  account_id   = "gce-sa"
  display_name = "Custom SA for VM Instance"
}

resource "google_compute_instance" "instance" {
  name         = var.instance_name
  machine_type = var.machine_type
  zone         = var.zone

  # Enable deletion protection
  deletion_protection = true

  # If an apply finds the VM stopped (e.g. a previous stop-for-update whose restart failed), start it.
  desired_status = "RUNNING"

  boot_disk {
    initialize_params {
      image = var.image
    }
  }

  network_interface {
    network    = var.network
    subnetwork = var.subnetwork
    dynamic "access_config" {
      for_each = var.give_external_ip ? [true] : []
      content {
        // Ephemeral public IP
      }
    }
  }

  service_account {
    # Narrow OAuth scopes (pentest finding WSG-009, DEV-10990): the broad `cloud-platform` scope let the VM attempt any
    # Google API, leaving IAM as the only restriction. This VM is a pure IAP SSH jump host — the DB/Redis tunnels
    # forward TCP straight to the targets' private IPs, so nothing on the box calls Google APIs with the attached SA
    # beyond the guest/Ops agents (logging + monitoring). `sqlservice.admin` is kept aligned with the SA's only IAM role
    # (roles/cloudsql.client) so running the Cloud SQL Auth Proxy on-box keeps working if ops ever need it; the scope
    # alone grants nothing without that IAM role. NB: changing scopes stops and restarts the VM on apply
    # (allow_stopping_for_update below), briefly dropping any open dev tunnels.
    email = var.service_account_email
    scopes = [
      "https://www.googleapis.com/auth/sqlservice.admin",
      "https://www.googleapis.com/auth/logging.write",
      "https://www.googleapis.com/auth/monitoring.write",
    ]
  }

  allow_stopping_for_update = true

  metadata = {
    block-project-ssh-keys = "true"
    enable-oslogin         = var.enable_oslogin ? "TRUE" : "FALSE"
  }

  metadata_startup_script = var.metadata_startup_script

  # Enable Shielded VM
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  lifecycle {
    ignore_changes = [metadata["ssh-keys"]]
  }
}
