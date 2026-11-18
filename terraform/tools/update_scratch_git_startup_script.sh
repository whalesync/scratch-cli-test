#!/bin/bash
set -euo pipefail

# Rolls the repo's scratch-git startup script out to an existing scratch-git VM.
#
# Terraform inlines terraform/modules/scratch_git_gce/scripts/startup.sh and deploy.sh into the VM's `startup-script`
# metadata, but ignores later changes to it (`lifecycle.ignore_changes`), because changing it in place would destroy and
# recreate the VM. So an edit to either file only reaches a VM that Terraform creates from scratch. This script updates
# a running VM's metadata to what Terraform would render today, and changes nothing else:
#   - the VM keeps running, and no container restarts;
#   - the new script runs at the VM's next boot (in test, the next wake after a pause).
#
# It reads the VM's current metadata, keeps the Terraform-injected variables at the top as they are, and replaces the
# embedded deploy.sh and startup.sh with the repo's copies, laid out exactly as Terraform renders them. It prints the
# diff, and only writes it with --apply. Don't run `sudo google_metadata_script_runner startup` on the VM to try a
# change: it reruns the metadata's copy, which is the old one until this has run.
#
# Runbook: docs/ops/runbook-scratch-git-startup-script-rollout.md
#
# Usage:
#   ./update_scratch_git_startup_script.sh <test|production>            # show what would change
#   ./update_scratch_git_startup_script.sh <test|production> --apply    # change it, after a confirmation
#
# Needs gcloud, jq, python3, and diff. --apply needs an account that can set the VM's metadata (not the read-only ones);
# production also needs an explicit go-ahead to change it.

usage() {
    echo "usage: $0 <test|production> [--apply]" >&2
    exit 1
}

die() {
    echo "error: $*" >&2
    exit 1
}

[ $# -ge 1 ] && [ $# -le 2 ] || usage
environment_short_name="$1"
apply_the_change="false"
if [ $# -eq 2 ]; then
    [ "$2" = "--apply" ] || usage
    apply_the_change="true"
fi
case "$environment_short_name" in
    test | production) ;;
    *) usage ;;
esac

GCP_PROJECT_ID="spv1eu-${environment_short_name}"
SCRATCH_GIT_INSTANCE_NAME="scratch-git"
SCRATCH_GIT_INSTANCE_ZONE="europe-west1-b"
REPOSITORY_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPOSITORY_STARTUP_SCRIPT_PATH="$REPOSITORY_ROOT/terraform/modules/scratch_git_gce/scripts/startup.sh"
REPOSITORY_DEPLOY_SCRIPT_PATH="$REPOSITORY_ROOT/terraform/modules/scratch_git_gce/scripts/deploy.sh"

for required_tool in gcloud jq python3 diff; do
    command -v "$required_tool" >/dev/null 2>&1 || die "'$required_tool' is required but not installed."
done
[ -f "$REPOSITORY_STARTUP_SCRIPT_PATH" ] && [ -f "$REPOSITORY_DEPLOY_SCRIPT_PATH" ] ||
    die "couldn't find startup.sh and deploy.sh under $REPOSITORY_ROOT/terraform/modules/scratch_git_gce/scripts."

gcloud_in_target_project() {
    gcloud "$@" --project="$GCP_PROJECT_ID" --billing-project="$GCP_PROJECT_ID"
}

# Prints the VM's startup-script metadata exactly, with no trailing newline added.
read_current_startup_script_metadata() {
    gcloud_in_target_project compute instances describe "$SCRATCH_GIT_INSTANCE_NAME" \
        --zone="$SCRATCH_GIT_INSTANCE_ZONE" --format=json |
        jq -j '[.metadata.items[]? | select(.key == "startup-script") | .value][0] // empty'
}

working_directory="$(mktemp -d)"
trap 'rm -rf "$working_directory"' EXIT
current_startup_script_metadata_path="$working_directory/startup-script.current"
rendered_startup_script_metadata_path="$working_directory/startup-script.rendered"

echo "Reading the startup-script metadata of $SCRATCH_GIT_INSTANCE_NAME in $GCP_PROJECT_ID..."
read_current_startup_script_metadata >"$current_startup_script_metadata_path" ||
    die "couldn't read the $SCRATCH_GIT_INSTANCE_NAME VM in $GCP_PROJECT_ID."
[ -s "$current_startup_script_metadata_path" ] ||
    die "the $SCRATCH_GIT_INSTANCE_NAME VM in $GCP_PROJECT_ID has no startup-script metadata."

# Terraform renders terraform/modules/scratch_git_gce/main.tf's heredoc as:
#   <header with the injected variables>
#   DEPLOY_SCRIPT=$(cat <<'DEPLOY_HEREDOC'\n <deploy.sh> \n DEPLOY_HEREDOC\n)\n
#   ...
#   # --- Main startup logic ---\n <startup.sh> \n
# Each file's own trailing newline is followed by the heredoc's line break, so each is followed by one extra "\n".
python3 -I - "$current_startup_script_metadata_path" "$REPOSITORY_DEPLOY_SCRIPT_PATH" "$REPOSITORY_STARTUP_SCRIPT_PATH" \
    "$rendered_startup_script_metadata_path" "$GCP_PROJECT_ID" <<'PYTHON'
import sys

current_path, deploy_path, startup_path, rendered_path, project_id = sys.argv[1:6]
current = open(current_path, encoding="utf-8").read()
repository_deploy_script = open(deploy_path, encoding="utf-8").read()
repository_startup_script = open(startup_path, encoding="utf-8").read()

deploy_opening_marker = "DEPLOY_SCRIPT=$(cat <<'DEPLOY_HEREDOC'\n"
deploy_closing_marker = "DEPLOY_HEREDOC\n)\n"
main_startup_logic_marker = "# --- Main startup logic ---\n"
for marker in (deploy_opening_marker, deploy_closing_marker, main_startup_logic_marker):
    if current.count(marker) != 1:
        sys.exit(f"error: the current metadata doesn't contain {marker!r} exactly once, so it isn't laid out the way "
                 "this script expects. Compare it with terraform/modules/scratch_git_gce/main.tf by hand.")
header, after_deploy_opening = current.split(deploy_opening_marker, 1)
_, after_deploy_closing = after_deploy_opening.split(deploy_closing_marker, 1)
between_deploy_and_main, _ = after_deploy_closing.split(main_startup_logic_marker, 1)
if f'GCP_PROJECT_ID="{project_id}"' not in header:
    sys.exit(f"error: the current metadata's header doesn't set GCP_PROJECT_ID=\"{project_id}\".")

rendered = (header + deploy_opening_marker + repository_deploy_script + "\n" + deploy_closing_marker
            + between_deploy_and_main + main_startup_logic_marker + repository_startup_script + "\n")
open(rendered_path, "w", encoding="utf-8").write(rendered)
PYTHON

if cmp -s "$current_startup_script_metadata_path" "$rendered_startup_script_metadata_path"; then
    echo "The VM's startup script already matches the repo. Nothing to change."
    exit 0
fi

echo "The VM's startup script differs from the repo's (- the VM, + the repo):"
diff -u --label "$SCRATCH_GIT_INSTANCE_NAME metadata startup-script ($GCP_PROJECT_ID)" \
    --label "rendered from the repo" \
    "$current_startup_script_metadata_path" "$rendered_startup_script_metadata_path" || true

if [ "$apply_the_change" != "true" ]; then
    echo
    echo "Nothing was changed. Run with --apply to update the metadata."
    exit 0
fi

active_account="$(gcloud config get-value account 2>/dev/null || true)"
impersonated_service_account="$(gcloud config get-value auth/impersonate_service_account 2>/dev/null || true)"
effective_identity="${impersonated_service_account:-${active_account:-unknown}}"
case "$effective_identity" in
    *-readonly@*) die "'$effective_identity' is a read-only account, which can't set the VM's metadata." ;;
esac

echo
echo "This updates the startup-script metadata of $SCRATCH_GIT_INSTANCE_NAME in $GCP_PROJECT_ID, as $effective_identity."
echo "The VM keeps running; the new script runs at its next boot."
read -r -p "Type '$environment_short_name' to go ahead: " typed_confirmation
[ "$typed_confirmation" = "$environment_short_name" ] || die "not confirmed, so nothing was changed."

gcloud_in_target_project compute instances add-metadata "$SCRATCH_GIT_INSTANCE_NAME" \
    --zone="$SCRATCH_GIT_INSTANCE_ZONE" --metadata-from-file=startup-script="$rendered_startup_script_metadata_path"

read_current_startup_script_metadata >"$current_startup_script_metadata_path"
cmp -s "$current_startup_script_metadata_path" "$rendered_startup_script_metadata_path" ||
    die "the metadata was written, but reading it back doesn't match. Run this again without --apply to see the difference."
echo "Updated. The new startup script runs at the VM's next boot."
