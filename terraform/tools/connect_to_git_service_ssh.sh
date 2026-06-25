#!/bin/bash
set -e

# Opens an interactive SSH shell on the scratch-git GCE instance via IAP tunnel.
# Unlike connect_to_git_service.sh (which port-forwards 3100 for talking to the
# REST API), this drops you onto the VM itself to inspect it.
#
# Which tier of access you land in is decided by your Google identity / IAM role,
# NOT by this script — the SSH command is the same for everyone:
#   - role_readonly_sa@whalesync.com    (the per-dev "gcp-ro" read-only SAs;
#                                        instance-scoped roles/compute.osLogin)
#       → a NON-admin, NON-sudo OS Login user. You can ONLY run the four
#         read-only `sudo gitops-*` wrappers listed in the banner below. You are
#         not in the docker group, so plain `docker ...` and `sudo docker ...`
#         are denied. This is the intended restricted, read-only inspection tier,
#         and the one your laptop/agent uses by default (the `gcp-ro` gcloud config).
#   - role_operations@whalesync.com     (roles/compute.admin + osAdminLogin)
#       → full root / sudo (google-sudoers). This is the break-glass tier used by
#         the recovery runbooks for cleanup, disk-space fixes, and exec.
#
# Prerequisites:
#   - Install and authenticate the gcloud CLI
#
# Usage:
#   ./connect_to_git_service_ssh.sh test
#   ./connect_to_git_service_ssh.sh production
#
# arg1: environment: 'test'|'production'

if [ $# -lt 1 ]; then
  echo "usage: $0 <environment>"
  echo "You must provide the name of the environment as the first argument: 'test' or 'production'."
  exit 1
fi

# Ensure gcloud is installed
if ! command -v gcloud &>/dev/null; then
  echo "gcloud could not be found, please install and authenticate."
  exit 1
fi

ENVIRONMENT=$1
GCP_PROJECT="spv1eu-${ENVIRONMENT}"

# Validate environment argument. Only 'test' and 'production' exist as GCP projects
# (spv1eu-test / spv1eu-production — see terraform/envs); there is no spv1eu-staging.
if [[ "$ENVIRONMENT" != "test" && "$ENVIRONMENT" != "production" ]]; then
  echo "Error: Invalid environment '$ENVIRONMENT'"
  echo "Allowed values: 'test' or 'production'"
  exit 1
fi

cat <<'BANNER'
-------------------------------------------------------------------------------
 scratch-git restricted (read-only) shell
-------------------------------------------------------------------------------
 As a role_readonly_sa@ "gcp-ro" (osLogin-only) user, you may ONLY run these:

   sudo gitops-ps                              # docker ps -a + docker stats
   sudo gitops-logs <container> [lines]        # docker logs (blue|green|proxy)
   sudo gitops-disk                            # df -h + docker system df + du
   sudo gitops-git  <org_../wkb_../coa_..> <subcommand> [args]   # read-only git

 Run `sudo -l` to confirm exactly what you're allowed to run.

 Anything mutating — docker cleanup/prune, disk-space fixes, rm, docker exec,
 repo writes — is break-glass: SSH again as a role_operations@ admin (root).
-------------------------------------------------------------------------------
BANNER

echo "Connecting to the scratch-git VM for $ENVIRONMENT (project $GCP_PROJECT)..."
exec gcloud compute ssh scratch-git --project "${GCP_PROJECT}" --zone europe-west1-b --tunnel-through-iap
