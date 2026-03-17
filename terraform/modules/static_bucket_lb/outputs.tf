output "ip_address" {
  description = "The IP address of the load balancer"
  value       = google_compute_global_address.static.address
}

output "bucket_name" {
  description = "The name of the GCS bucket"
  value       = google_storage_bucket.static.name
}

output "bucket_url" {
  description = "The URL of the GCS bucket"
  value       = google_storage_bucket.static.url
}
