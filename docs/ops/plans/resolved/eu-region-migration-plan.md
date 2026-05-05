# EU Region Migration Plan

## Overview

Migrate Scratch infrastructure from US (us-central1) to EU (europe-west1) to meet customer data residency requirements.

**Current State:** Infrastructure in `us-central1` across two GCP projects (spv1-test, spv1-production)

**Target State:** Infrastructure in `europe-west1` across two new GCP projects (spv1eu-test, spv1eu-production)

**Approach:** Fresh deployment (no data migration needed - no existing customers)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Current (US)                                │
├─────────────────────────────────────────────────────────────────┤
│  GCP Projects: spv1-test, spv1-production                       │
│  Region: us-central1 (Iowa)                                     │
│  Domains: app.scratch.md, api.scratch.md, agent.scratch.md      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                     Target (EU)                                 │
├─────────────────────────────────────────────────────────────────┤
│  GCP Projects: spv1eu-test, spv1eu-production                   │
│  Region: europe-west1 (Belgium)                                 │
│  Domains: app.scratch.md, api.scratch.md, agent.scratch.md      │
│           (same domains, DNS redirect)                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Create GCP Projects

### 1.1 Create Projects in Google Cloud Console

Create two new GCP projects:

| Setting             | Test               | Production         |
| ------------------- | ------------------ | ------------------ |
| **Project Name**    | spv1eu-test        | spv1eu-production  |
| **Project ID**      | spv1eu-test        | spv1eu-production  |
| **Organization**    | (same as existing) | (same as existing) |
| **Billing Account** | (same as existing) | (same as existing) |

### 1.2 Enable Required APIs

For each project, enable the following APIs (Terraform will also do this, but pre-enabling speeds up initial apply):

```bash
gcloud config set project spv1eu-test  # or spv1eu-production

gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  redis.googleapis.com \
  compute.googleapis.com \
  secretmanager.googleapis.com \
  certificatemanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudresourcemanager.googleapis.com \
  iam.googleapis.com \
  iap.googleapis.com
```

---

## Phase 2: Create Terraform State Buckets

### 2.1 Create GCS Buckets for Terraform State

```bash
# Test environment state bucket
gcloud storage buckets create gs://spv1eu-test-tfstate \
  --project=spv1eu-test \
  --location=europe-west1 \
  --uniform-bucket-level-access

# Production environment state bucket
gcloud storage buckets create gs://spv1eu-production-tfstate \
  --project=spv1eu-production \
  --location=europe-west1 \
  --uniform-bucket-level-access
```

### 2.2 Enable Versioning (for state recovery)

```bash
gcloud storage buckets update gs://spv1eu-test-tfstate --versioning
gcloud storage buckets update gs://spv1eu-production-tfstate --versioning
```

---

## Phase 3: Create EU Terraform Configurations

### 3.1 Create Directory Structure

```
terraform/envs/
├── test/           # Existing US test
├── production/     # Existing US production
├── eu-test/        # NEW: EU test
└── eu-production/  # NEW: EU production
```

### 3.2 Create EU Test Configuration

**File:** `terraform/envs/eu-test/backend.tf`

```hcl
terraform {
  backend "gcs" {
    bucket = "spv1eu-test-tfstate"
    prefix = "terraform/state"
  }
}
```

**File:** `terraform/envs/eu-test/eu-test.tf`

```hcl
module "env" {
  source = "../../modules/env"

  env_name       = "spv1eu-test"
  gcp_project_id = "spv1eu-test"
  gcp_region     = "europe-west1"
  gcp_zone       = "europe-west1-b"

  client_domain = "eu-test.scratch.md"      # Temporary test domain
  api_domain    = "eu-test-api.scratch.md"  # Temporary test domain
  agent_domain  = "eu-test-agent.scratch.md" # Temporary test domain

  # Test environment settings
  enable_cloud_ids  = false
  cloudsql_ha       = false
  redis_ha          = false
  scratch_git       = true

  # ... (copy other variables from existing test config)
}
```

**File:** `terraform/envs/eu-test/outputs.tf`

```hcl
output "client_ip" {
  value = module.env.client_ip
}

output "api_ip" {
  value = module.env.api_ip
}

output "agent_ip" {
  value = module.env.agent_ip
}

output "nat_egress_ip" {
  value = module.env.nat_egress_ip
}
```

### 3.3 Create EU Production Configuration

**File:** `terraform/envs/eu-production/backend.tf`

```hcl
terraform {
  backend "gcs" {
    bucket = "spv1eu-production-tfstate"
    prefix = "terraform/state"
  }
}
```

**File:** `terraform/envs/eu-production/eu-production.tf`

```hcl
module "env" {
  source = "../../modules/env"

  env_name       = "spv1eu-production"
  gcp_project_id = "spv1eu-production"
  gcp_region     = "europe-west1"
  gcp_zone       = "europe-west1-b"

  # Production domains (after DNS cutover)
  client_domain = "app.scratch.md"
  api_domain    = "api.scratch.md"
  agent_domain  = "agent.scratch.md"

  # Production environment settings
  enable_cloud_ids  = true   # Or false to save cost initially
  cloudsql_ha       = true
  redis_ha          = true
  scratch_git       = true

  # ... (copy other variables from existing production config)
}
```

---

## Phase 4: Create Artifact Registry in EU

### 4.1 Add Artifact Registry Resource

The existing Terraform modules should create an Artifact Registry. Verify the region is set correctly in the module.

If creating manually first:

```bash
# For test
gcloud artifacts repositories create spv1eu-test-registry \
  --project=spv1eu-test \
  --repository-format=docker \
  --location=europe-west1 \
  --description="Docker images for EU test environment"

# For production
gcloud artifacts repositories create spv1eu-production-registry \
  --project=spv1eu-production \
  --repository-format=docker \
  --location=europe-west1 \
  --description="Docker images for EU production environment"
```

### 4.2 Image URL Format

Images will be pushed to:

```
europe-west1-docker.pkg.dev/spv1eu-test/spv1eu-test-registry/IMAGE_NAME:TAG
europe-west1-docker.pkg.dev/spv1eu-production/spv1eu-production-registry/IMAGE_NAME:TAG
```

---

## Phase 5: Run Terraform

### 5.1 Initialize and Apply EU Test

```bash
cd terraform/envs/eu-test

# Initialize with new backend
terraform init

# Review plan
terraform plan

# Apply infrastructure
terraform apply
```

### 5.2 Initialize and Apply EU Production

```bash
cd terraform/envs/eu-production

terraform init
terraform plan
terraform apply
```

### 5.3 Expected Resources Created

Per environment:

- 1 VPC with 2 subnets
- 1 Cloud NAT with static IP
- 1 Cloud SQL PostgreSQL instance
- 1 Memorystore Redis instance
- 3 Cloud Run services (client, api, agent)
- 3 Global HTTPS Load Balancers
- 3 SSL certificates
- ~30 secrets in Secret Manager
- IAM service accounts and roles
- Artifact Registry repository

---

## Phase 6: Create Secrets

### 6.1 Copy Secrets to New Projects

Secrets need to be created in the new EU projects. Use the existing `terraform/secrets.txt` as a reference.

**Option A: Manual creation via Console**
Create each secret in Google Cloud Console > Secret Manager

**Option B: Script to copy secrets**

```bash
#!/bin/bash
# copy-secrets.sh

SOURCE_PROJECT="spv1-test"
TARGET_PROJECT="spv1eu-test"

# List of secrets to copy (from terraform/secrets.txt)
SECRETS=(
  "CLERK_PUBLISHABLE_KEY"
  "CLERK_SECRET_KEY"
  "DATABASE_URL"
  # ... add all secrets
)

for SECRET in "${SECRETS[@]}"; do
  # Get secret value from source
  VALUE=$(gcloud secrets versions access latest --secret="$SECRET" --project="$SOURCE_PROJECT")

  # Create secret in target (if not exists)
  gcloud secrets create "$SECRET" --project="$TARGET_PROJECT" 2>/dev/null || true

  # Add new version
  echo -n "$VALUE" | gcloud secrets versions add "$SECRET" --data-file=- --project="$TARGET_PROJECT"
done
```

**Note:** Some secrets will need new values:

- `DATABASE_URL` - New EU database connection string
- `REDIS_PASSWORD` - Generated by Terraform for EU Redis
- Any environment-specific URLs

---

## Phase 7: Update GitLab CI/CD

### 7.1 Update OIDC Federation

Add Workload Identity Federation for the new EU projects in GitLab.

**In each EU GCP project:**

1. Create Workload Identity Pool for GitLab
2. Create Provider with GitLab OIDC settings
3. Grant service account impersonation to GitLab

The existing `terraform/modules/gitlab_oidc/` module can be used.

### 7.2 Update .gitlab-ci.yml

Add new deployment jobs for EU environments:

```yaml
deploy-eu-test:
  stage: deploy
  environment: eu-test
  variables:
    GCP_PROJECT: spv1eu-test
    GCP_REGION: europe-west1
  script:
    -  # Build and push to EU Artifact Registry
    - docker build -t europe-west1-docker.pkg.dev/spv1eu-test/spv1eu-test-registry/client:$CI_COMMIT_SHA ./client
    - docker push europe-west1-docker.pkg.dev/spv1eu-test/spv1eu-test-registry/client:$CI_COMMIT_SHA
    # ... similar for api and agent
    -  # Deploy Cloud Run services
    - gcloud run deploy client --image=... --region=europe-west1 --project=spv1eu-test

deploy-eu-production:
  stage: deploy
  environment: eu-production
  variables:
    GCP_PROJECT: spv1eu-production
    GCP_REGION: europe-west1
  # ... similar to above
```

---

## Phase 8: Deploy Services

### 8.1 Build and Push Images

```bash
# Authenticate to EU Artifact Registry
gcloud auth configure-docker europe-west1-docker.pkg.dev

# Build and push client
cd client
docker build -t europe-west1-docker.pkg.dev/spv1eu-test/spv1eu-test-registry/client:latest .
docker push europe-west1-docker.pkg.dev/spv1eu-test/spv1eu-test-registry/client:latest

# Build and push api
cd ../server
docker build -t europe-west1-docker.pkg.dev/spv1eu-test/spv1eu-test-registry/api:latest .
docker push europe-west1-docker.pkg.dev/spv1eu-test/spv1eu-test-registry/api:latest

# Build and push agent (if separate)
# ...
```

### 8.2 Deploy to Cloud Run

```bash
# Deploy client
gcloud run deploy client \
  --image=europe-west1-docker.pkg.dev/spv1eu-test/spv1eu-test-registry/client:latest \
  --region=europe-west1 \
  --project=spv1eu-test

# Deploy api
gcloud run deploy api \
  --image=europe-west1-docker.pkg.dev/spv1eu-test/spv1eu-test-registry/api:latest \
  --region=europe-west1 \
  --project=spv1eu-test
```

### 8.3 Run Database Migrations

```bash
# Connect to EU Cloud SQL and run migrations
cd server
DATABASE_URL="postgresql://..." yarn run migrate
```

---

## Phase 9: Verification

### 9.1 Test EU Infrastructure

```bash
# Check Cloud Run services are running
gcloud run services list --region=europe-west1 --project=spv1eu-test

# Check Cloud SQL
gcloud sql instances list --project=spv1eu-test

# Check Redis
gcloud redis instances list --region=europe-west1 --project=spv1eu-test

# Get load balancer IPs
cd terraform/envs/eu-test
terraform output
```

### 9.2 Test Application

1. Access the temporary test domains (if configured)
2. Or add local /etc/hosts entries pointing to the new IPs
3. Verify:
   - Client loads correctly
   - API responds to health checks
   - Database connections work
   - Redis connections work
   - Authentication flows work

---

## Phase 10: DNS Cutover

### 10.1 Get New IP Addresses

```bash
cd terraform/envs/eu-production
terraform output client_ip
terraform output api_ip
terraform output agent_ip
```

### 10.2 Update GoDaddy DNS

In GoDaddy DNS Management for scratch.md:

| Type | Name  | Value           | TTL |
| ---- | ----- | --------------- | --- |
| A    | app   | (new client_ip) | 600 |
| A    | api   | (new api_ip)    | 600 |
| A    | agent | (new agent_ip)  | 600 |

### 10.3 Verify DNS Propagation

```bash
# Check DNS resolution
dig app.scratch.md
dig api.scratch.md
dig agent.scratch.md

# Or use online tools
# https://dnschecker.org/
```

---

## Rollback Plan

If issues arise after DNS cutover:

1. **Revert DNS** - Point domains back to US IPs in GoDaddy
2. **US infrastructure remains intact** - No changes made to spv1-test/spv1-production

---

## Post-Migration Cleanup

After confirming EU deployment is stable:

1. **Decommission US infrastructure** (optional, or keep for disaster recovery)

   ```bash
   cd terraform/envs/test
   terraform destroy

   cd terraform/envs/production
   terraform destroy
   ```

2. **Update documentation** - Remove references to US region

3. **Update CLAUDE.md** - Update region references

---

## Cost Considerations

- **No additional cost** for running in EU vs US (same pricing)
- **Temporary overlap** - Both US and EU running during migration (can destroy US after)
- **Static IP** - ~$7/month per environment
- **Cloud SQL** - Main cost driver (~$50-100/month depending on tier)
- **Redis** - ~$30-50/month depending on tier

---

## Timeline Checklist

- [ ] Phase 1: Create GCP projects (spv1eu-test, spv1eu-production)
- [ ] Phase 2: Create Terraform state buckets
- [ ] Phase 3: Create EU Terraform configurations
- [ ] Phase 4: Create Artifact Registry
- [ ] Phase 5: Run Terraform (create infrastructure)
- [ ] Phase 6: Create/copy secrets
- [ ] Phase 7: Update GitLab CI/CD
- [ ] Phase 8: Deploy services
- [ ] Phase 9: Verify everything works
- [ ] Phase 10: DNS cutover
- [ ] Post-migration: Cleanup US infrastructure
