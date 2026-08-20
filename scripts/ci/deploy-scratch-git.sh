#!/usr/bin/env bash
#
# Blue/green deploy of the scratch-git service onto its GCE VM, over IAP SSH,
# then verify the new build is the one actually serving traffic.
#
# WHY THIS EXISTS
# The deploy runs as two `gcloud compute ssh` calls against the `scratch-git`
# VM: one to run the remote blue/green `deploy.sh`, and one to read
# `localhost:3100/health` back through the nginx proxy and confirm the new
# commit is live. Both go through IAP as the CI service account, and both can
# be rejected transiently:
#
#   sa_1177...82@compute.13045...92: Permission denied (publickey).
#   ERROR: (gcloud.compute.ssh) [/usr/bin/ssh] exited with return code [255].
#
# That is an OS Login / SSH-key-propagation race, not a broken deploy. The CI
# config had a retry loop around the FIRST ssh only, so the race hit the
# unprotected health check instead and failed the job three times — 2026-07-08
# (pipeline 2662972093), 2026-07-29 (2716823136) and 2026-08-20 (2777036079) —
# every time AFTER the remote deploy had already printed "Deploy complete."
# The service was live and healthy; only the verification handshake failed.
#
# The health check is also worth retrying on its own merits: nginx reloads
# ahead of the new container being fully warm, so a first read can legitimately
# return a stale build marker or a refused connection.
#
# This script is the single implementation for BOTH the test and production
# deploy jobs. They were byte-identical copies before, which is how production
# silently inherited the same un-retried health check.
#
# USAGE
#   bash scripts/ci/deploy-scratch-git.sh <gcp-project> <zone> <image-url> <expected-build-marker>
#
# e.g.
#   bash scripts/ci/deploy-scratch-git.sh spv1eu-test europe-west1-b \
#     "${GCP_REGISTRY_URL}/spinner-scratch-git:${CI_COMMIT_SHORT_SHA}" \
#     "${CI_COMMIT_SHORT_SHA}"
#
# A health check that the VM actually answers — the wrong build marker, an empty
# body, or a refused connection from the remote `curl` — is retried too (the
# container may still be warming), but when the attempts run out it is reported
# as a deploy problem rather than an ssh flake, and that verdict is sticky: a
# later "Permission denied (publickey)" attempt can never talk the script back
# into the benign "probably live and healthy" message.

set -euo pipefail

readonly SCRATCH_GIT_INSTANCE_NAME="scratch-git"
readonly SCRATCH_GIT_HEALTH_URL="http://localhost:3100/health"
readonly REMOTE_DEPLOY_SCRIPT_PATH="/mnt/disks/data/.deploy/deploy.sh"
readonly MAX_SSH_ATTEMPTS="${SCRATCH_GIT_DEPLOY_MAX_SSH_ATTEMPTS:-4}"
readonly BASE_BACKOFF_SECONDS="${SCRATCH_GIT_DEPLOY_BASE_BACKOFF_SECONDS:-10}"
# `gcloud compute ssh` reports an ssh-level failure (including "Permission
# denied (publickey)") as 255; any other non-zero status is the REMOTE command's
# own exit status, i.e. we did reach the VM.
readonly SSH_LEVEL_FAILURE_EXIT_STATUS=255

usage_and_exit() {
  echo "usage: $0 <gcp-project> <zone> <image-url> <expected-build-marker>" >&2
  exit 2
}

if [ "$#" -ne 4 ]; then
  echo "ERROR: expected 4 arguments, got $#" >&2
  usage_and_exit
fi

readonly gcp_project="$1"
readonly gcp_zone="$2"
readonly image_url="$3"
readonly expected_build_marker="$4"

# Fail at the boundary with a readable message rather than letting an empty
# value turn into a confusing gcloud error twenty lines later.
for argument_name in gcp_project gcp_zone image_url expected_build_marker; do
  if [ -z "${!argument_name}" ]; then
    echo "ERROR: <${argument_name//_/-}> must not be empty" >&2
    usage_and_exit
  fi
done

is_non_negative_integer() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

# The tuning knobs get the same boundary check as the positional arguments. A
# non-numeric value would make `[ "$attempt_number" -ge "$MAX_SSH_ATTEMPTS" ]`
# exit 2, which the retry loop would read as "not exhausted yet" and spin on
# until the job timeout — while holding the deploy `resource_group`.
if ! is_non_negative_integer "$MAX_SSH_ATTEMPTS" || [ "$MAX_SSH_ATTEMPTS" -lt 1 ]; then
  echo "ERROR: SCRATCH_GIT_DEPLOY_MAX_SSH_ATTEMPTS must be an integer >= 1, got '${MAX_SSH_ATTEMPTS}'" >&2
  exit 2
fi
if ! is_non_negative_integer "$BASE_BACKOFF_SECONDS"; then
  echo "ERROR: SCRATCH_GIT_DEPLOY_BASE_BACKOFF_SECONDS must be an integer >= 0, got '${BASE_BACKOFF_SECONDS}'" >&2
  exit 2
fi

# Ephemeral runners have no ~/.ssh; gcloud would otherwise prompt and generate
# keys mid-job.
prepare_ssh_key_for_ephemeral_runner() {
  mkdir -p ~/.ssh && chmod 700 ~/.ssh
  if [ ! -f "$HOME/.ssh/google_compute_engine" ]; then
    echo "No ~/.ssh/google_compute_engine on this runner — generating one."
    ssh-keygen -t rsa -b 3072 -f "$HOME/.ssh/google_compute_engine" -N "" -q
  fi
}

run_command_over_ssh_on_the_vm() {
  local remote_command="$1"
  gcloud compute ssh "$SCRATCH_GIT_INSTANCE_NAME" \
    --project "$gcp_project" \
    --zone "$gcp_zone" \
    --tunnel-through-iap \
    --quiet \
    -- "$remote_command"
}

# Exponential backoff with a little jitter, so two deploy jobs that collide on
# the same key-propagation window do not retry in lockstep. The previous flat
# 15s wait was tuned for a single hiccup; doubling gives the OS Login profile
# noticeably longer to settle without making a genuine failure slow to surface.
sleep_before_next_attempt() {
  local attempt_number="$1"
  local backoff_seconds=$((BASE_BACKOFF_SECONDS * attempt_number + RANDOM % 5))
  echo "  ...retrying in ${backoff_seconds}s"
  sleep "$backoff_seconds"
}

# Runs the named function until it succeeds or the attempts run out. The
# function is responsible for its own logging; this only handles the loop.
retry_until_success_with_backoff() {
  local step_description="$1"
  local single_attempt_function_name="$2"
  local attempt_number=1

  while true; do
    echo "==> ${step_description} (attempt ${attempt_number}/${MAX_SSH_ATTEMPTS})"
    if "$single_attempt_function_name"; then
      return 0
    fi
    if [ "$attempt_number" -ge "$MAX_SSH_ATTEMPTS" ]; then
      echo "ERROR: ${step_description} failed after ${MAX_SSH_ATTEMPTS} attempts" >&2
      return 1
    fi
    sleep_before_next_attempt "$attempt_number"
    attempt_number=$((attempt_number + 1))
  done
}

attempt_remote_deploy() {
  run_command_over_ssh_on_the_vm "sudo bash ${REMOTE_DEPLOY_SCRIPT_PATH} ${image_url}"
}

# Tracks why the health check last failed, so the final message can tell an
# ssh problem (the service is probably fine) apart from a service problem (the
# VM answered us and the answer was wrong).
last_health_check_failure_reason="never ran"
# STICKY: once any attempt has got as far as the VM running our curl, the
# diagnosis can never be downgraded back to the benign "it was just ssh"
# message. Without this, a confirmed wrong-build reading on attempt 1 would be
# overwritten by an OS Login flake on attempt 4 — exactly the message this
# script must never print over a real bad deploy.
a_health_check_attempt_reached_the_vm="false"

# The ssh handshake never completed — nothing was learned about the service.
record_health_check_failure_from_ssh() {
  local failure_reason="$1"
  # Do not overwrite a reason recorded by an attempt that actually reached the
  # VM; that one is the more serious, more informative fact.
  if [ "$a_health_check_attempt_reached_the_vm" = "false" ]; then
    last_health_check_failure_reason="$failure_reason"
  fi
}

# We got onto the VM and it answered (or refused) our curl — this is the
# service's own verdict, and it outranks any ssh flake before or after it.
record_health_check_failure_from_the_service() {
  local failure_reason="$1"
  a_health_check_attempt_reached_the_vm="true"
  last_health_check_failure_reason="$failure_reason"
}

attempt_health_check() {
  local health_payload
  local ssh_exit_status=0
  health_payload=$(run_command_over_ssh_on_the_vm "curl -sf ${SCRATCH_GIT_HEALTH_URL}") || ssh_exit_status=$?

  if [ "$ssh_exit_status" -ne 0 ]; then
    if [ "$ssh_exit_status" -eq "$SSH_LEVEL_FAILURE_EXIT_STATUS" ]; then
      record_health_check_failure_from_ssh "could not ssh to ${SCRATCH_GIT_INSTANCE_NAME} to read ${SCRATCH_GIT_HEALTH_URL}"
      echo "  ssh to the VM failed (exit ${ssh_exit_status}) — /health was never read" >&2
    else
      # The remote `curl -sf` itself failed (7 = connection refused, 22 = HTTP
      # error, ...). We reached the VM; the service on it did not serve us. If
      # the blue/green swap left nginx pointing at a dead slot this is a real
      # outage, so it must NOT be filed under "probably just ssh".
      record_health_check_failure_from_the_service "reached ${SCRATCH_GIT_INSTANCE_NAME} but ${SCRATCH_GIT_HEALTH_URL} did not serve a response (remote curl exit ${ssh_exit_status})"
      echo "  the VM answered but /health did not (remote curl exit ${ssh_exit_status}) — the service may be down" >&2
    fi
    return 1
  fi

  echo "  /health -> ${health_payload}"

  if [ -z "$health_payload" ]; then
    record_health_check_failure_from_the_service "scratch-git returned an empty ${SCRATCH_GIT_HEALTH_URL} body"
    return 1
  fi

  case "$health_payload" in
    *"$expected_build_marker"*)
      return 0
      ;;
    *)
      record_health_check_failure_from_the_service "scratch-git is serving a build that does not contain '${expected_build_marker}': ${health_payload}"
      echo "  wrong build still serving traffic — the new container may not be warm yet" >&2
      return 1
      ;;
  esac
}

echo "Deploying ${image_url}"
echo "  to instance '${SCRATCH_GIT_INSTANCE_NAME}' in ${gcp_project} / ${gcp_zone}"

prepare_ssh_key_for_ephemeral_runner

if ! retry_until_success_with_backoff "remote blue/green deploy" attempt_remote_deploy; then
  echo "ERROR: the remote deploy never completed — scratch-git was NOT updated." >&2
  exit 1
fi

if ! retry_until_success_with_backoff "verify deployed build via /health" attempt_health_check; then
  echo "ERROR: could not verify the deployed build: ${last_health_check_failure_reason}" >&2
  echo "" >&2
  if [ "$a_health_check_attempt_reached_the_vm" = "false" ]; then
    echo "NOTE: the remote deploy above succeeded and no attempt ever got an ssh session" >&2
    echo "onto the VM, so scratch-git is very likely live and healthy. A 'Permission" >&2
    echo "denied (publickey)' / exit code 255 here is an OS Login key-propagation race on" >&2
    echo "the CI service account, not a bad deploy — check the VM directly with" >&2
    echo "terraform/tools/connect_to_git_service_ssh.sh before assuming the release is" >&2
    echo "broken." >&2
  else
    echo "NOTE: an attempt DID reach the VM and the service either failed to answer" >&2
    echo "/health or reported the wrong build, so treat this as a real deploy problem" >&2
    echo "rather than the usual ssh flake. scratch-git may still be serving the previous" >&2
    echo "image, or nothing at all — investigate the remote blue/green swap on the VM." >&2
  fi
  exit 1
fi

echo "Deploy verified: scratch-git in ${gcp_project} is serving ${expected_build_marker}"
