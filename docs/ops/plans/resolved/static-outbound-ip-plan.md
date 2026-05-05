# Static Outbound IP Address for Customer Whitelisting

## Overview

Enable customers to whitelist a stable IP address for outbound HTTP requests from our servers. This is needed when customers' services are behind Cloudflare bot protection or similar firewall rules that require IP whitelisting.

**Problem:** Our Cloud Run services make outbound requests through Cloud NAT configured with `AUTO_ONLY` IP allocation. GCP can change this IP without notice, making it unreliable for customer whitelisting.

**Solution:** Reserve a static external IP address and configure Cloud NAT to use manual allocation.

## Current Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Cloud Run Services (Client/API)                         │
│ - Next.js app (port 3000)                               │
│ - NestJS API (port 3010)                                │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│ Cloud NAT (nat-router)                                  │
│ - nat_ip_allocate_option = "AUTO_ONLY"  ← Problem       │
│ - IP can change without notice                          │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
              External APIs
              (unstable IP)
```

## Target Architecture

```
┌─────────────────────────────────────────────────────────┐
│ Cloud Run Services (Client/API)                         │
└──────────────────────┬──────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────┐
│ Cloud NAT (nat-router)                                  │
│ - nat_ip_allocate_option = "MANUAL_ONLY"                │
│ - nat_ips = [reserved static IP]                        │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
              External APIs
              (stable, whitelistable IP)
```

---

## Phase 1: Reserve Static IP Address

### 1.1 Create IP Address Resource

**File:** `terraform/modules/cloudnat/main.tf`

Add a new resource to reserve a static external IP:

```hcl
resource "google_compute_address" "nat_egress" {
  name         = "nat-egress-ip"
  region       = var.gcp_region
  address_type = "EXTERNAL"
  network_tier = "PREMIUM"  # Required for Cloud NAT
  project      = var.gcp_project_id

  description = "Static IP for Cloud NAT egress - customers can whitelist this IP"
}
```

### 1.2 Add Output for IP Address

**File:** `terraform/modules/cloudnat/outputs.tf`

Create this file (or add to existing):

```hcl
output "nat_egress_ip" {
  description = "Static IP address for outbound traffic (for customer whitelisting)"
  value       = google_compute_address.nat_egress.address
}
```

---

## Phase 2: Configure Cloud NAT for Manual Allocation

### 2.1 Update NAT Configuration

**File:** `terraform/modules/cloudnat/main.tf`

Change the `google_compute_router_nat` resource:

```hcl
resource "google_compute_router_nat" "nat" {
  name                               = "my-router-nat"
  router                             = google_compute_router.router.name
  region                             = google_compute_router.router.region

  # Change from AUTO_ONLY to MANUAL_ONLY
  nat_ip_allocate_option             = "MANUAL_ONLY"
  nat_ips                            = [google_compute_address.nat_egress.self_link]

  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"

  log_config {
    enable = true
    filter = "ERRORS_ONLY"
  }
}
```

**Key changes:**

- `nat_ip_allocate_option`: `"AUTO_ONLY"` → `"MANUAL_ONLY"`
- `nat_ips`: Add reference to the reserved static IP

---

## Phase 3: Propagate Output to Environment

### 3.1 Module Output

**File:** `terraform/environments/production/outputs.tf` (or appropriate env file)

Add output to expose the IP at the environment level:

```hcl
output "nat_egress_ip" {
  description = "Static outbound IP for customer whitelisting"
  value       = module.cloudnat.nat_egress_ip
}
```

### 3.2 Test Environment

Apply the same changes to `terraform/environments/test/` if you want the test environment to also have a static IP (recommended for consistency).

---

## Phase 4: Documentation

### 4.1 Update Infrastructure Documentation

**File:** `terraform/README.md` (or create if doesn't exist)

Add a section documenting the static IP:

````markdown
## Static Outbound IP

All outbound HTTP requests from Cloud Run services use a single static IP address
via Cloud NAT. This IP can be provided to customers for firewall whitelisting.

To retrieve the current IP:

```bash
gcloud compute addresses describe nat-egress-ip \
  --region=europe-west1 \
  --format='get(address)'
```
````

Or via Terraform output:

```bash
cd terraform/environments/production
terraform output nat_egress_ip
```

````

### 4.2 Customer-Facing Documentation

Create documentation (location TBD based on your docs system) explaining:

1. Why whitelisting may be needed (Cloudflare bot protection, firewalls)
2. The static IP address to whitelist
3. That this IP applies to all outbound requests from Scratch servers

---

## Verification

### Terraform Plan

```bash
cd terraform/environments/production
terraform plan
````

**Expected changes:**

- 1 resource added: `google_compute_address.nat_egress`
- 1 resource modified: `google_compute_router_nat.nat`

### Terraform Apply

```bash
terraform apply
```

### Verify IP Assignment

```bash
# Check the reserved IP
gcloud compute addresses describe nat-egress-ip \
  --region=europe-west1 \
  --format='get(address)'

# Verify NAT is using it
gcloud compute routers nats describe my-router-nat \
  --router=nat-router \
  --region=europe-west1
```

### Test Outbound Requests

From a Cloud Run service, make a request to an IP-checking service:

```bash
curl https://api.ipify.org
curl https://ifconfig.me
```

The returned IP should match the reserved static IP.

---

## Rollback Plan

If issues arise, revert to auto-allocation:

```hcl
resource "google_compute_router_nat" "nat" {
  # ...
  nat_ip_allocate_option = "AUTO_ONLY"
  # Remove: nat_ips = [...]
}
```

The reserved IP can be kept or deleted separately.

---

## Cost Considerations

- **Static IP cost:** ~$0.01/hour when attached to a resource (~$7.30/month)
- **No additional egress costs** - NAT egress pricing remains the same
- **Single IP is sufficient** unless we exceed NAT port limits (64K concurrent connections per IP)

---

## Files Summary

| File                                           | Action        | Description                               |
| ---------------------------------------------- | ------------- | ----------------------------------------- |
| `terraform/modules/cloudnat/main.tf`           | Modify        | Add static IP resource, update NAT config |
| `terraform/modules/cloudnat/outputs.tf`        | Create/Modify | Export static IP address                  |
| `terraform/environments/production/outputs.tf` | Modify        | Expose IP at environment level            |
| `terraform/environments/test/outputs.tf`       | Modify        | (Optional) Same for test env              |
| `terraform/README.md`                          | Modify        | Document static IP usage                  |

---

## Future Considerations

### Multiple IPs for High Throughput

If we ever need more than 64K concurrent outbound connections, we can reserve additional IPs:

```hcl
resource "google_compute_address" "nat_egress" {
  count  = 2  # or more
  name   = "nat-egress-ip-${count.index}"
  # ...
}

resource "google_compute_router_nat" "nat" {
  nat_ips = google_compute_address.nat_egress[*].self_link
  # ...
}
```

Customers would then need to whitelist multiple IPs.

### Per-Connector Static IPs

If different connectors need different source IPs (for audit/tracking), this would require a more complex architecture with multiple NAT gateways or a proxy layer.
