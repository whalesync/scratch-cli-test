# Scratch GCP Infrastructure

Terraform modules for Scratch's GCP environments

## Repo Structure

```
terraform
├── README.md
├── envs
│   ├── test
│   ├── staging
│   └── production
└── modules
    ├── env
    ├── gitlab_oidc
    ├── iam_service_accounts
    └── vpc
```

- **envs:**
  Contains the main Terraform configuration files for each environment. Each environment (`test`, `staging`, `production`) corresponds to a distinct GCP project.
  - `test`: Config files for the test environment.
  - `staging`: Config files for the staging environment.
  - `production`: Config files for the production environment.

- **modules:**
  Each subdirectory represents a reusable GCP module written in Terraform, which can be used across multiple environments.
  - `env`: Wrapper module for defining a full environment.
  - `iam_service_accounts`: Module for managing Identity and Access Management (IAM) service accounts.
  - `gitlab_oidc`: Module for managing OIDC auth for Gitlab CI.
  - `vpc`: Module for setting up the Virtual Private Cloud (VPC) network.

## Configure for local development

If you're using VS Code:

- Install this extension: https://marketplace.visualstudio.com/items?itemName=HashiCorp.terraform
- Follow the instructions here to enable code formatting on save: https://marketplace.visualstudio.com/items?itemName=HashiCorp.terraform#formatting

If using another editor or IDE, the standard formatter is built into terraform. You can use `terraform fmt` or any extension that runs it to get the same results. It's pretty fast, so running it on save is usually fine.

## How to plan and deploy locally

### First time setup

- Install gcloud and tfenv

```
brew install --cask google-cloud-sdk
brew install tfenv
```

- Authenticate with gcloud

```
gcloud auth login
```

- Install the current version of terraform with tfenv

```
cd ./envs/test
tfenv install

terraform -version # The output should match what's in .terraform-version
```

1. Change to the env directory you want to deploy (e.g. `terraform/envs/test`)
2. Run `terraform init` (You'll only need to run this again if you create new modules)
3. Run `terraform plan` to see what changes will be made
4. Run `terraform apply` to actually apply the changes

## Creating a new environment

Step 1: Create a Cloud Storage Bucket to hold `tfstate` in a central place for access by multiple developers. This is a separate step as the main Terraform cannot be initialized without the bucket existing.

More information [here](https://cloud.google.com/docs/terraform/resource-management/store-state).

Step 2: Deploy resources to an environment

- cd into the env subdirectory you are deploying to (ie `./envs/production`); create it if necessary
- copy the following files into the new env folder:
- 1. <env_name>.tf
- 2. variables.tf
- 5. backend.tf
- in `backend.tf` make sure the bucket name is the same as in Step 1
- run:
- `terraform init`
- `terraform validate`
- `terraform plan`
- `terraform apply`
- If it complains about APIs not being enabled, run `terraform apply` again after a couple seconds

## Testing whether Gitlab can run the deploy

You can confirm whether a deploy is possible to run with the service account Gitlab uses by temporarily forcing the google terraform provider to impersonate it.

1. First make sure you have the "Service Account Token Creator" role on the project. This role has additional permissions that "Owner" doesn't.
2. Wait a few minutes for the IAM permissions to propagate if you just added the role.
3. Run terraform commands with `-var as_gitlab=true`

```
terraform plan -var as_gitlab=true
```

## Static Outbound IP

All outbound HTTP requests from Cloud Run services use a single static IP address via Cloud NAT. This IP can be provided to customers for firewall whitelisting (e.g., when their services are behind Cloudflare bot protection).

To retrieve the current IP:

```bash
# Via gcloud
gcloud compute addresses describe nat-egress-ip \
  --region=europe-west1 \
  --format='get(address)'

# Via Terraform output
cd terraform/envs/production
terraform output nat_egress_ip
```

## Maintenance Mode

To enable maintenance mode for the client service, run `terraform apply` with the `maintenance_mode_enabled` variable set to `true`. This sets the `MAINTENANCE_MODE_ENABLED` environment variable on the client Cloud Run service, which causes it to serve the static maintenance page instead of the normal app.

```bash
cd terraform/envs/eu-production
terraform apply -var maintenance_mode_enabled=true
```

To disable maintenance mode, run `terraform apply` again without the flag (it defaults to `false`):

```bash
terraform apply
```

## DNS Management

Scratch uses the `scratch.md` domain which is managed on GoDaddy using thier DNS Management service.

Login with the team@whalesync.com account (creds in 1PW) and go to the [DNS Management](https://dcc.godaddy.com/control/dnsmanagement?domainName=scratch.md) page.
