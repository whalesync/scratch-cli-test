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
    email  = var.service_account_email
    scopes = ["cloud-platform"]
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
