# US Infrastructure Teardown Plan

This document describes the procedure for destroying the test and production environments defined in `terraform/envs/test` and `terraform/envs/production`.

**This is destructive and irreversible** — proceed with extreme caution, especially for production.

## Prerequisites

1. **Terraform 1.13.4** installed (see `terraform/.terraform-version`)
2. **GCP authentication** configured for the target projects (`spv1-test` and `spv1-production`)

## Step 1: Disable CI/CD Pipelines

Disable any GitLab CI/CD pipelines that deploy to these environments to prevent Terraform resources from being re-created after destruction.

## Step 2: Remove Deletion Protection

Several resources have deletion protection that will cause `terraform destroy` to fail:

1. **Cloud SQL instances** — `deletion_protection = true` in `terraform/modules/cloudsql/main.tf`
2. **Monitoring alert policies** — `prevent_destroy = true` lifecycle rule in `terraform/modules/env/monitoring.tf`

To remove protection:

- In `terraform/modules/cloudsql/main.tf`: set `deletion_protection = false`
- In `terraform/modules/env/monitoring.tf`: remove or set `prevent_destroy = false` on the lifecycle blocks
- Run `terraform apply` in each environment to apply the protection changes **before** running destroy:

```bash
cd terraform/envs/test
terraform init
terraform apply

cd terraform/envs/production
terraform init
terraform apply
```

## Step 3: Destroy Test Environment

Destroy test first to validate the process before touching production.

```bash
cd terraform/envs/test
terraform init
terraform plan -destroy    # Review what will be destroyed
terraform destroy          # Type "yes" to confirm
```

## Step 4: Destroy Production Environment

```bash
cd terraform/envs/production
terraform init
terraform plan -destroy    # Review carefully!
terraform destroy          # Type "yes" to confirm
```

## Step 5: Clean Up State Buckets (Optional)

The GCS state buckets are not managed by Terraform and will remain after destroy:

- `spv1-test-tfstate`
- `spv1-production-tfstate`

Delete these manually if you want to fully clean up:

```bash
gsutil rm -r gs://spv1-test-tfstate
gsutil rm -r gs://spv1-production-tfstate
```

## EU Environments

If you also need to tear down the EU environments, follow the same procedure for:

- `terraform/envs/eu-test` (project: `spv1eu-test`, state bucket: `spv1eu-test-tfstate`)
- `terraform/envs/eu-production` (project: `spv1eu-production`, state bucket: `spv1eu-production-tfstate`)

## Important Notes

- **Database name reuse**: Cloud SQL instance names with random suffixes cannot be reused in GCP for ~2 weeks after deletion.
- **DNS records**: Records pointing to `test.scratch.md`, `app.scratch.md`, etc. may need separate cleanup if managed outside Terraform.
- **GCP APIs**: Enabled APIs have `disable_on_destroy = false` and will remain active on the project after destroy.
- **Order of operations**: Always destroy test before production to validate the process.
