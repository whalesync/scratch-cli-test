#!/bin/bash
set -euo pipefail

# Pauses and wakes Scratch's test environment (spv1eu-test) so it doesn't run overnight or on weekends (DEV-12906).
# The "Pause test env" GitLab schedule pauses test at 11 pm PT every night, and the "Wake test env" schedule wakes it at
# 4:45 am PT on weekdays. Every master pipeline, and every Scheduled CLI Tests run, wakes it first (`wake test`, see
# gitlab-ci/test-power.yml). That wake changes nothing when test is already up.
# Plan, savings, and risks: docs/ops/plans/2026-11-16-pause-test-overnight.md
#
# What pauses:
#   - api-service, worker-service, and cron-service: service-level manual scaling with 0 instances. That creates no
#     revision, and Terraform ignores the service-level `scaling` block (terraform/modules/env/services.tf).
#   - the primary Cloud SQL instance: activation policy NEVER. Its storage and private IP stay.
#   - the scratch-git VM: stopped. Its disks stay, and its startup script runs again when it boots.
# What keeps running: client-service (request-billed, already scales to 0), Redis, the cloudsql-proxy bastion, the load
# balancers, and NAT.
#
# A pause stops the services that add work (cron and api), then the worker, gives scratch-git a minute to finish
# in-flight requests, then stops the VM and the database. A wake starts the database and the VM, waits for the VM's
# startup script and for scratch-git to report healthy behind its load balancer, then starts api and worker, and cron
# last, so the worker exists before the cron's reapers run (the same order as maintenance_mode.sh).
#
# Test's alerts email the team, and a pause trips some of them, so a pause snoozes those policies for up to 7 days
# before it changes anything, and a wake ends the snooze.
#
# Both `wake` and `pause` refuse to run while test is in maintenance mode (terraform/tools/maintenance_mode.sh), so
# neither one starts or stops anything under a maintenance window.
#
# CI runs this as gitlab-service-account@spv1eu-test. Developers' read-only accounts can only run `status`. To wake or
# pause test by hand, run the manual pipeline: Build > Pipelines > Run pipeline, on master, with TEST_POWER=wake (or
# pause).
#
# Needs gcloud with `run services update --scaling` (unawareguitar/gcp-dind has it), jq, and curl. Runs on the bash 3.2
# that macOS ships.
#
# Usage:
#   ./test_power.sh status   # show each service's scaling, the database, the VM, scratch-git's health, and the snooze
#   ./test_power.sh wake     # if anything is paused: start the database and the VM, then the services
#   ./test_power.sh pause    # snooze the alerts, stop the services, then the VM and the database

usage() {
    echo "usage: $0 status | wake | pause" >&2
    exit 1
}

GCP_PROJECT_ID="spv1eu-test"
CLOUD_RUN_REGION="europe-west1"
SCRATCH_GIT_INSTANCE_NAME="scratch-git"
SCRATCH_GIT_INSTANCE_ZONE="europe-west1-b"
# The internal TCP load balancer's backend in front of the scratch-git VM (terraform/modules/scratch_git_gce/main.tf).
SCRATCH_GIT_BACKEND_SERVICE_NAME="scratch-git-backend-service"
API_HEALTH_URL="https://test-api.scratch.md/health"

# Test's maintenance-mode lockdown rule (terraform/modules/env/maintenance.tf, flipped by maintenance_mode.sh).
MAINTENANCE_SECURITY_POLICY_NAME="eu-test-maintenance"
MAINTENANCE_LOCKDOWN_RULE_PRIORITY=1000
MAINTENANCE_LOCKDOWN_DENY_ACTION_VALUE="deny(502)"

# Paused first: the services that add work, so nothing new is queued while the worker stops.
SERVICES_THAT_ADD_WORK_IN_PAUSE_ORDER="cron-service api-service"
SERVICES_THAT_DO_THE_WORK_IN_PAUSE_ORDER="worker-service"
# Woken in two steps: api and worker together, then cron once the worker has had time to start.
SERVICES_WOKEN_FIRST="api-service worker-service"
SERVICES_WOKEN_LAST="cron-service"
ALL_PAUSED_SERVICES="api-service worker-service cron-service"

POLL_INTERVAL_SECONDS=15
# After the worker stops, before the VM stops, so a scratch-git request the worker started can finish.
SCRATCH_GIT_DRAIN_SECONDS=60
# The same pause maintenance_mode.sh leaves between the worker and the cron (BACKEND_RESUME_SETTLE_SECONDS).
WORKER_SETTLE_SECONDS_BEFORE_CRON=45
# The startup script prunes Docker and pulls the scratch-git and nginx images, so it takes a few minutes.
STARTUP_SCRIPT_TIMEOUT_SECONDS=720
# A wake checks the startup script whenever the VM booted this recently, even if this run didn't start it: an earlier
# wake that failed partway, and then retried, may have.
RECENT_BOOT_WINDOW_SECONDS=1800
SCRATCH_GIT_HEALTHY_TIMEOUT_SECONDS=300
API_HEALTHY_TIMEOUT_SECONDS=300

# The alert policies a pause trips (terraform/modules/env/monitoring.tf), by display name. Requests to the paused
# services get 503s; "Scratch Git Memory > 85%" has an absence condition, so it fires once the VM stops; and a boot can
# trip the ops agent and CPU alerts. The database alerts are thresholds only, so a stopped database doesn't fire them.
SNOOZED_ALERT_POLICY_DISPLAY_NAMES=(
    "Scratch Eu-Test API Service - 5xx Errors"
    "Scratch Eu-Test Client Service - 5xx Errors"
    "Scratch Eu-Test Cron Service - 5xx Errors"
    "Scratch Eu-Test Scratch Git Memory > 85%"
    "Scratch Eu-Test Scratch Git Ops Agent unresponsive"
    "Scratch Eu-Test Scratch Git CPU > 90%"
)
SNOOZE_DISPLAY_NAME="Test is paused"
# Long enough for a long holiday weekend. A wake ends it sooner.
SNOOZE_DURATION="P7D"

# The same webhook maintenance_mode.sh posts to.
SLACK_WEBHOOK_SECRET_NAME="SLACK_NOTIFICATION_WEBHOOK_URL"
SLACK_REQUEST_TIMEOUT_SECONDS=10

last_error_message=""

die() {
    last_error_message="$*"
    echo "error: $*" >&2
    exit 1
}

warn() {
    echo "warning: $*" >&2
}

## ---------------------------------------------------------------------------------------------------------------------
## gcloud helpers
## ---------------------------------------------------------------------------------------------------------------------

# --billing-project keeps quota attribution on test, which the per-dev read-only accounts need even for `status`.
gcloud_in_target_project() {
    gcloud "$@" --project="$GCP_PROJECT_ID" --billing-project="$GCP_PROJECT_ID"
}

effective_gcloud_identity() {
    local impersonated_service_account active_account
    impersonated_service_account="$(gcloud config get-value auth/impersonate_service_account 2>/dev/null || true)"
    active_account="$(gcloud config get-value account 2>/dev/null || true)"
    if [ -n "$impersonated_service_account" ]; then
        echo "$impersonated_service_account"
    else
        echo "${active_account:-unknown}"
    fi
}

require_identity_that_can_change_test() {
    local identity
    identity="$(effective_gcloud_identity)"
    case "$identity" in
        *-readonly@*)
            die "'$identity' is a read-only account, which can only run 'status'. To wake or pause test, run the manual pipeline: Build > Pipelines > Run pipeline, on master, with TEST_POWER=wake (or pause)."
            ;;
    esac
}

# Older gcloud versions have no --scaling.
require_gcloud_with_scaling_flag() {
    local services_update_help
    services_update_help="$(gcloud run services update --help 2>/dev/null || true)"
    case "$services_update_help" in
        *--scaling*) ;;
        *) die "this gcloud has no 'run services update --scaling'. Run 'gcloud components update', or use unawareguitar/gcp-dind." ;;
    esac
}

# Prints a UTC timestamp for $1 seconds ago, with GNU or BSD date.
utc_timestamp_seconds_ago() {
    local seconds_ago="$1" epoch_seconds
    epoch_seconds=$(($(date -u +%s) - seconds_ago))
    date -u -d "@$epoch_seconds" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$epoch_seconds" +%Y-%m-%dT%H:%M:%SZ
}

# Prints "Nm Ns" for the seconds since $1 (a value of $SECONDS).
duration_since() {
    local elapsed_seconds=$((SECONDS - $1))
    echo "$((elapsed_seconds / 60))m $((elapsed_seconds % 60))s"
}

## ---------------------------------------------------------------------------------------------------------------------
## Maintenance mode
## ---------------------------------------------------------------------------------------------------------------------

# Prints ON, PREVIEW, OFF, or UNKNOWN, the same as maintenance_mode.sh's lockdown_state.
maintenance_lockdown_state() {
    local rule_action_and_preview rule_action rule_preview
    rule_action_and_preview="$(gcloud_in_target_project compute security-policies rules describe \
        "$MAINTENANCE_LOCKDOWN_RULE_PRIORITY" --security-policy="$MAINTENANCE_SECURITY_POLICY_NAME" \
        --format='value(action,preview)' 2>/dev/null || true)"
    rule_action="$(printf '%s' "$rule_action_and_preview" | cut -f1)"
    rule_preview="$(printf '%s' "$rule_action_and_preview" | cut -f2)"
    if [ -z "$rule_action" ]; then
        echo "UNKNOWN"
    elif [ "$rule_action" = "$MAINTENANCE_LOCKDOWN_DENY_ACTION_VALUE" ] && [ "$rule_preview" = "True" ]; then
        echo "PREVIEW"
    elif [ "$rule_action" = "$MAINTENANCE_LOCKDOWN_DENY_ACTION_VALUE" ]; then
        echo "ON"
    else
        echo "OFF"
    fi
}

# A wake would start the backends that maintenance mode stopped, and a pause would stop the database under whatever
# the window is for. A preview window blocks nothing, so it doesn't count.
require_test_not_in_maintenance_mode() {
    local maintenance_lockdown_state_now
    maintenance_lockdown_state_now="$(maintenance_lockdown_state)"
    case "$maintenance_lockdown_state_now" in
        ON)
            die "test is in maintenance mode, so nothing was changed. End the window first with 'terraform/tools/maintenance_mode.sh test off'."
            ;;
        UNKNOWN)
            warn "couldn't read the $MAINTENANCE_SECURITY_POLICY_NAME lockdown rule, so this can't tell whether test is in maintenance mode. Going on."
            ;;
    esac
}

## ---------------------------------------------------------------------------------------------------------------------
## Cloud Run services
## ---------------------------------------------------------------------------------------------------------------------

# Prints "manual" or "automatic", or "unreadable" when the service can't be described.
cloud_run_service_scaling_mode() {
    local service_name="$1" service_json
    if ! service_json="$(gcloud_in_target_project run services describe "$service_name" \
        --region="$CLOUD_RUN_REGION" --format=json 2>/dev/null)"; then
        echo "unreadable"
        return 0
    fi
    jq -r '.metadata.annotations["run.googleapis.com/scalingMode"] // "automatic"' <<<"$service_json"
}

# Prints a service's scaling, any service-level min or max, and its latest revision. --scaling=0 deletes a service's
# service-level min and max, and --scaling=auto doesn't restore them; the revision's own min and max still apply.
cloud_run_service_status_line() {
    local service_name="$1" service_json
    if ! service_json="$(gcloud_in_target_project run services describe "$service_name" \
        --region="$CLOUD_RUN_REGION" --format=json 2>/dev/null)"; then
        echo "unreadable"
        return 0
    fi
    # shellcheck disable=SC2016 # jq variables, not shell ones
    jq -r '.metadata.annotations as $annotations
        | (if $annotations["run.googleapis.com/scalingMode"] != "manual" then "automatic"
            elif $annotations["run.googleapis.com/manualInstanceCount"] == "0" then "PAUSED (manual, 0 instances)"
            else "manual, \($annotations["run.googleapis.com/manualInstanceCount"]) instances" end)
        + (if $annotations["run.googleapis.com/minScale"] != null or $annotations["run.googleapis.com/maxScale"] != null
            then ", service min \($annotations["run.googleapis.com/minScale"] // "none") max \($annotations["run.googleapis.com/maxScale"] // "none")"
            else "" end)
        + ", revision \(.status.latestReadyRevisionName // "none")"' <<<"$service_json"
}

# $1 = 0 or auto, then the services. Updates them all at once and fails if any update failed.
set_scaling_of_services_in_parallel() {
    local scaling_value="$1" service_name index any_update_failed=0
    shift
    local service_names=() update_process_ids=()
    for service_name in "$@"; do
        (
            gcloud_in_target_project run services update "$service_name" --region="$CLOUD_RUN_REGION" \
                --scaling="$scaling_value" --quiet 2>&1 | sed "s/^/  [$service_name] /"
        ) &
        service_names+=("$service_name")
        update_process_ids+=("$!")
    done
    for ((index = 0; index < ${#service_names[@]}; index++)); do
        if wait "${update_process_ids[$index]}"; then
            echo "  ${service_names[$index]}: scaling set to $scaling_value."
        else
            echo "error: couldn't set ${service_names[$index]} to --scaling=$scaling_value." >&2
            any_update_failed=1
        fi
    done
    return "$any_update_failed"
}

## ---------------------------------------------------------------------------------------------------------------------
## Cloud SQL
## ---------------------------------------------------------------------------------------------------------------------

primary_database_instance_name=""

# Finds the primary instance by its label. No --limit: gcloud applies it before --filter for this command (see
# server/tools/run_database_migrations.sh). Must be called directly, not inside $(...), so the name survives.
load_primary_database_instance_name() {
    local matching_instance_names matching_instance_count
    matching_instance_names="$(gcloud_in_target_project sql instances list --filter='labels.primary=true' \
        --format='value(name)')" || die "couldn't list the Cloud SQL instances in $GCP_PROJECT_ID."
    matching_instance_count="$(printf '%s\n' "$matching_instance_names" | grep -c . || true)"
    if [ "$matching_instance_count" != "1" ]; then
        die "expected exactly one Cloud SQL instance labeled primary=true in $GCP_PROJECT_ID, found $matching_instance_count: ${matching_instance_names:-none}."
    fi
    primary_database_instance_name="$matching_instance_names"
}

# Prints ALWAYS (started) or NEVER (stopped), or nothing when it can't be read.
primary_database_activation_policy() {
    gcloud_in_target_project sql instances describe "$primary_database_instance_name" \
        --format='value(settings.activationPolicy)' 2>/dev/null || true
}

primary_database_status_line() {
    local database_json
    if ! database_json="$(gcloud_in_target_project sql instances describe "$primary_database_instance_name" \
        --format=json 2>/dev/null)"; then
        echo "unreadable"
        return 0
    fi
    jq -r '(if .settings.activationPolicy == "ALWAYS" then "started"
            elif .settings.activationPolicy == "NEVER" then "PAUSED (stopped)"
            else "activation policy \(.settings.activationPolicy)" end)
        + ", state \(.state)"' <<<"$database_json"
}

# $1 = ALWAYS to start the database, NEVER to stop it. Does nothing if it's already that way. gcloud waits for the
# database to start or stop.
set_primary_database_activation_policy() {
    local target_activation_policy="$1" current_activation_policy started_at_seconds=$SECONDS
    current_activation_policy="$(primary_database_activation_policy)"
    if [ "$current_activation_policy" = "$target_activation_policy" ]; then
        echo "  $primary_database_instance_name: activation policy is already $target_activation_policy."
        return 0
    fi
    gcloud_in_target_project sql instances patch "$primary_database_instance_name" \
        --activation-policy="$target_activation_policy" --quiet 2>&1 | sed "s/^/  [$primary_database_instance_name] /"
    echo "  $primary_database_instance_name: activation policy set to $target_activation_policy in $(duration_since "$started_at_seconds")."
}

## ---------------------------------------------------------------------------------------------------------------------
## scratch-git VM
## ---------------------------------------------------------------------------------------------------------------------

# Prints RUNNING, TERMINATED, STOPPING, and so on, or nothing when it can't be read.
scratch_git_instance_status() {
    gcloud_in_target_project compute instances describe "$SCRATCH_GIT_INSTANCE_NAME" \
        --zone="$SCRATCH_GIT_INSTANCE_ZONE" --format='value(status)' 2>/dev/null || true
}

scratch_git_instance_id() {
    gcloud_in_target_project compute instances describe "$SCRATCH_GIT_INSTANCE_NAME" \
        --zone="$SCRATCH_GIT_INSTANCE_ZONE" --format='value(id)' 2>/dev/null || true
}

# Prints when the VM's current boot started, in UTC, as 2026-11-17T12:45:00Z, or nothing when it can't be read.
scratch_git_current_boot_started_at() {
    gcloud_in_target_project compute instances describe "$SCRATCH_GIT_INSTANCE_NAME" \
        --zone="$SCRATCH_GIT_INSTANCE_ZONE" \
        --format='value(lastStartTimestamp.date(format="%Y-%m-%dT%H:%M:%SZ", tz=UTC))' 2>/dev/null || true
}

# Prints HEALTHY or UNHEALTHY, as the internal load balancer's health check sees scratch-git on port 3100, or nothing
# when it can't be read.
scratch_git_backend_health_state() {
    gcloud_in_target_project compute backend-services get-health "$SCRATCH_GIT_BACKEND_SERVICE_NAME" \
        --region="$CLOUD_RUN_REGION" --format='value(status.healthStatus[].healthState)' 2>/dev/null || true
}

# $1 = start or stop. gcloud waits until the VM is running or stopped.
start_or_stop_scratch_git_instance() {
    local start_or_stop="$1" started_at_seconds=$SECONDS
    gcloud_in_target_project compute instances "$start_or_stop" "$SCRATCH_GIT_INSTANCE_NAME" \
        --zone="$SCRATCH_GIT_INSTANCE_ZONE" --quiet 2>&1 | sed "s/^/  [$SCRATCH_GIT_INSTANCE_NAME] /"
    echo "  $SCRATCH_GIT_INSTANCE_NAME: ${start_or_stop} finished in $(duration_since "$started_at_seconds")."
}

# The guest agent's lines about the startup script since $2, "Finished running startup scripts" and
# "startup-script exit status N", each as "<UTC timestamp to the second><tab><line>", oldest first. It reads them from
# two places and prints whatever either one has:
#   - the serial console, where syslog lines start with an ISO 8601 UTC timestamp (2026-10-05T12:12:00.528360+00:00).
#     Only lines stamped at or after $2 count, so an earlier boot's lines never do, whether or not the console kept them
#     across the stop and start. Lines in any other format are ignored. It's immediate, but the API only returns the
#     last 1 MB;
#   - Cloud Logging (GCEMetadataScripts, or syslog through the ops agent), from $2 on, which can lag a little.
# $1 = the instance id, $2 = the earliest UTC timestamp, as 2026-11-17T12:45:00Z. Only these lines are printed, never the
# script's own output.
scratch_git_startup_script_lines_since() {
    local instance_id="$1" earliest_timestamp="$2" serial_console_output cloud_logging_entries
    local log_filter="resource.type=\"gce_instance\" AND resource.labels.instance_id=\"$instance_id\""
    log_filter+=" AND (logName=\"projects/$GCP_PROJECT_ID/logs/GCEMetadataScripts\" OR logName=\"projects/$GCP_PROJECT_ID/logs/syslog\")"
    log_filter+=" AND timestamp>=\"$earliest_timestamp\""
    log_filter+=" AND (\"Finished running startup scripts\" OR \"startup-script exit status\")"
    serial_console_output="$(gcloud_in_target_project compute instances get-serial-port-output \
        "$SCRATCH_GIT_INSTANCE_NAME" --zone="$SCRATCH_GIT_INSTANCE_ZONE" 2>/dev/null || true)"
    cloud_logging_entries="$(gcloud_in_target_project logging read "$log_filter" --limit=20 \
        --format='value(timestamp,jsonPayload.message,textPayload)' 2>/dev/null || true)"
    {
        printf '%s\n' "$serial_console_output" | awk -v earliest_timestamp="$earliest_timestamp" '
            $1 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/ &&
            substr($1, 1, 19) >= substr(earliest_timestamp, 1, 19) &&
            /Finished running startup scripts|startup-script exit status [0-9]+/ { print substr($1, 1, 19) "\t" $0 }'
        printf '%s\n' "$cloud_logging_entries" | awk -F '\t' '
            $1 != "" { print substr($1, 1, 19) "\t" ($2 != "" ? $2 : $3) }'
    } | sort
}

# Waits for the VM's startup script, which runs on every boot, to finish. It mounts the data disk and recreates the
# scratch-git containers, and nothing may use scratch-git before it has: until then, Docker may already have restarted
# the old containers against the not-yet-mounted data directory, and the master pipeline's scratch-git deploy mustn't
# run alongside it. $1 = the instance id, $2 = when the current boot started, in UTC.
#
# Returns 0 when the script finished and its latest exit status is 0, 1 when its latest exit status is anything else,
# and 2 when no finish showed up in time (the caller then relies on scratch-git's health check alone).
wait_until_scratch_git_startup_script_finished() {
    local instance_id="$1" boot_started_at="$2" elapsed_seconds=0 startup_script_lines latest_exit_status
    while [ "$elapsed_seconds" -le "$STARTUP_SCRIPT_TIMEOUT_SECONDS" ]; do
        startup_script_lines="$(scratch_git_startup_script_lines_since "$instance_id" "$boot_started_at")"
        case "$startup_script_lines" in
            *"Finished running startup scripts"*)
                latest_exit_status="$(printf '%s\n' "$startup_script_lines" |
                    grep -Eo 'startup-script exit status [0-9]+' | tail -1 | awk '{ print $4 }' || true)"
                if [ -z "$latest_exit_status" ]; then
                    warn "the startup script finished, but its exit status wasn't found. Relying on scratch-git's health check."
                    return 0
                fi
                echo "  The startup script finished with exit status $latest_exit_status."
                [ "$latest_exit_status" = "0" ] || return 1
                return 0
                ;;
        esac
        echo "  ${elapsed_seconds}s: waiting for the startup script to finish..."
        sleep "$POLL_INTERVAL_SECONDS"
        elapsed_seconds=$((elapsed_seconds + POLL_INTERVAL_SECONDS))
    done
    return 2
}

wait_until_scratch_git_backend_is_healthy() {
    local elapsed_seconds=0 backend_health_state
    while [ "$elapsed_seconds" -le "$SCRATCH_GIT_HEALTHY_TIMEOUT_SECONDS" ]; do
        backend_health_state="$(scratch_git_backend_health_state)"
        echo "  ${elapsed_seconds}s: $SCRATCH_GIT_BACKEND_SERVICE_NAME -> ${backend_health_state:-unreadable}"
        if [ "$backend_health_state" = "HEALTHY" ]; then
            return 0
        fi
        sleep "$POLL_INTERVAL_SECONDS"
        elapsed_seconds=$((elapsed_seconds + POLL_INTERVAL_SECONDS))
    done
    return 1
}

## ---------------------------------------------------------------------------------------------------------------------
## API health
## ---------------------------------------------------------------------------------------------------------------------

# /health is liveness-only, but api exits at boot when Postgres is unreachable (server/src/db/db.service.ts), so a 200
# from a freshly started api also means the database is back.
wait_until_api_is_healthy() {
    local elapsed_seconds=0 api_health_status_code
    while [ "$elapsed_seconds" -le "$API_HEALTHY_TIMEOUT_SECONDS" ]; do
        api_health_status_code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 \
            "$API_HEALTH_URL" 2>/dev/null || true)"
        echo "  ${elapsed_seconds}s: $API_HEALTH_URL -> ${api_health_status_code:-no response}"
        if [ "$api_health_status_code" = "200" ]; then
            return 0
        fi
        sleep "$POLL_INTERVAL_SECONDS"
        elapsed_seconds=$((elapsed_seconds + POLL_INTERVAL_SECONDS))
    done
    return 1
}

## ---------------------------------------------------------------------------------------------------------------------
## Alert snooze
## ---------------------------------------------------------------------------------------------------------------------

# Prints the resource names of the active snoozes this script made, one per line. Fails when they can't be listed.
active_test_is_paused_snooze_names() {
    local snoozes_json now_utc
    snoozes_json="$(gcloud_in_target_project monitoring snoozes list --format=json)" || return 1
    now_utc="$(date -u +%Y-%m-%dT%H:%M:%S)"
    jq -r --arg display_name "$SNOOZE_DISPLAY_NAME" --arg now_utc "$now_utc" \
        '.[] | select(.displayName == $display_name and .interval.endTime[0:19] > $now_utc) | .name' <<<"$snoozes_json"
}

# Snoozes SNOOZED_ALERT_POLICY_DISPLAY_NAMES unless a snooze is already active. A failure only warns: the pause matters
# more, and the alerts only email the team.
snooze_the_alerts_a_pause_trips() {
    local existing_snooze_names alert_policies_json display_name policy_resource_name joined_policy_resource_names
    local policy_resource_names=()
    if ! existing_snooze_names="$(active_test_is_paused_snooze_names)"; then
        warn "couldn't list the alert snoozes, so the alerts weren't snoozed."
        return 0
    fi
    if [ -n "$existing_snooze_names" ]; then
        echo "  The alerts are already snoozed."
        return 0
    fi
    if ! alert_policies_json="$(gcloud_in_target_project monitoring policies list --format=json)"; then
        warn "couldn't list the alert policies, so the alerts weren't snoozed."
        return 0
    fi
    for display_name in "${SNOOZED_ALERT_POLICY_DISPLAY_NAMES[@]}"; do
        policy_resource_name="$(jq -r --arg display_name "$display_name" \
            '[.[] | select(.displayName == $display_name) | .name][0] // empty' <<<"$alert_policies_json")"
        if [ -z "$policy_resource_name" ]; then
            warn "there's no alert policy named \"$display_name\", so it isn't snoozed."
            continue
        fi
        policy_resource_names+=("$policy_resource_name")
    done
    if [ "${#policy_resource_names[@]}" -eq 0 ]; then
        warn "found none of the alert policies to snooze."
        return 0
    fi
    joined_policy_resource_names="$(IFS=,; echo "${policy_resource_names[*]}")"
    if gcloud_in_target_project monitoring snoozes create --display-name="$SNOOZE_DISPLAY_NAME" \
        --criteria-policies="$joined_policy_resource_names" --start-time=+PT1S --end-time="+$SNOOZE_DURATION" \
        --format=none; then
        echo "  Snoozed ${#policy_resource_names[@]} alert policies for up to 7 days."
    else
        warn "couldn't snooze the alerts."
    fi
}

# Ends every active snooze this script made. A failure only warns: the snooze ends on its own within 7 days.
end_the_alert_snooze() {
    local active_snooze_names active_snooze_name
    if ! active_snooze_names="$(active_test_is_paused_snooze_names)"; then
        warn "couldn't list the alert snoozes, so they weren't ended."
        return 0
    fi
    for active_snooze_name in $active_snooze_names; do
        if gcloud_in_target_project monitoring snoozes cancel "$active_snooze_name" --format=none; then
            echo "  Ended the alert snooze."
        else
            warn "couldn't end the alert snooze $active_snooze_name."
        fi
    done
}

## ---------------------------------------------------------------------------------------------------------------------
## Slack
## ---------------------------------------------------------------------------------------------------------------------

# The webhook URL is a credential. It's read from Secret Manager into memory, never printed, and handed to curl on stdin
# so it doesn't appear in the process list. Slack never fails the caller.
slack_webhook_url=""
slack_webhook_url_load_was_attempted="false"

# Must be called directly, not inside $(...), so the loaded value survives.
load_slack_webhook_url_once() {
    if [ "$slack_webhook_url_load_was_attempted" = "true" ]; then
        return 0
    fi
    slack_webhook_url_load_was_attempted="true"
    slack_webhook_url="$(gcloud_in_target_project secrets versions access latest \
        --secret="$SLACK_WEBHOOK_SECRET_NAME" 2>/dev/null || true)"
    case "$slack_webhook_url" in
        https://hooks.slack.com/*) ;;
        *)
            slack_webhook_url=""
            warn "couldn't read a Slack webhook URL from the $SLACK_WEBHOOK_SECRET_NAME secret, so this won't post to Slack."
            ;;
    esac
}

# $1 = the message, in Slack mrkdwn. Adds a link to the CI job, or the account that ran this.
notify_slack() {
    local message_text="$1" request_payload response_status_code
    load_slack_webhook_url_once
    [ -n "$slack_webhook_url" ] || return 0
    if [ -n "${CI_JOB_URL:-}" ]; then
        message_text+=" <${CI_JOB_URL}|View job>"
    else
        message_text+=" (run by $(effective_gcloud_identity))"
    fi
    request_payload="$(jq -nc --arg text "$message_text" '{text: $text}')"
    response_status_code="$(printf 'url = "%s"\n' "$slack_webhook_url" | curl --config - --silent --output /dev/null \
        --write-out '%{http_code}' --max-time "$SLACK_REQUEST_TIMEOUT_SECONDS" --request POST \
        --header 'Content-Type: application/json' --data "$request_payload" 2>/dev/null)" || true
    if [ "$response_status_code" != "200" ]; then
        warn "couldn't post to Slack."
    fi
}

# Set while a wake or pause that Slack was told about is in flight, so an exit partway through is reported too.
operation_in_flight_description=""

notify_slack_if_the_operation_did_not_finish() {
    local script_exit_status=$?
    if [ "$script_exit_status" -ne 0 ] && [ -n "$operation_in_flight_description" ]; then
        notify_slack ":warning: *${operation_in_flight_description} didn't finish.* ${last_error_message:-The script exited unexpectedly.} Check \`terraform/tools/test_power.sh status\`, then run it again."
    fi
}
trap notify_slack_if_the_operation_did_not_finish EXIT

## ---------------------------------------------------------------------------------------------------------------------
## Commands
## ---------------------------------------------------------------------------------------------------------------------

# True when nothing is paused: no service is at manual scaling, the database's activation policy is ALWAYS, and the VM
# is running. Anything it can't read counts as paused, so the full wake runs and reports it.
wake_is_noop() {
    local service_name
    for service_name in $ALL_PAUSED_SERVICES; do
        [ "$(cloud_run_service_scaling_mode "$service_name")" = "automatic" ] || return 1
    done
    [ "$(primary_database_activation_policy)" = "ALWAYS" ] || return 1
    [ "$(scratch_git_instance_status)" = "RUNNING" ] || return 1
}

command_status() {
    local service_name snooze_line="not snoozed" active_snooze_names
    load_primary_database_instance_name
    for service_name in $ALL_PAUSED_SERVICES; do
        printf '%-30s %s\n' "$service_name" "$(cloud_run_service_status_line "$service_name")"
    done
    printf '%-30s %s\n' "$primary_database_instance_name" "$(primary_database_status_line)"
    printf '%-30s %s\n' "$SCRATCH_GIT_INSTANCE_NAME" \
        "$(scratch_git_instance_status | sed -e 's/^TERMINATED$/PAUSED (TERMINATED)/' -e 's/^$/unreadable/')"
    printf '%-30s %s\n' "$SCRATCH_GIT_BACKEND_SERVICE_NAME" "$(scratch_git_backend_health_state | sed 's/^$/unreadable/')"
    if ! active_snooze_names="$(active_test_is_paused_snooze_names 2>/dev/null)"; then
        snooze_line="unknown: couldn't list the snoozes"
    elif [ -n "$active_snooze_names" ]; then
        snooze_line="snoozed (\"$SNOOZE_DISPLAY_NAME\")"
    fi
    printf '%-30s %s\n' "alerts" "$snooze_line"
    printf '%-30s %s\n' "maintenance lockdown" "$(maintenance_lockdown_state)"
}

command_wake() {
    local wake_started_at_seconds=$SECONDS scratch_git_status_before_wake scratch_git_id_before_wake
    local scratch_git_start_requested_at="" scratch_git_boot_started_at database_start_process_id
    local scratch_git_start_process_id=""
    local any_start_failed=0 startup_script_wait_result=0
    require_gcloud_with_scaling_flag
    load_primary_database_instance_name
    if wake_is_noop; then
        echo "Test is already awake."
        end_the_alert_snooze
        return 0
    fi
    require_identity_that_can_change_test
    require_test_not_in_maintenance_mode
    scratch_git_status_before_wake="$(scratch_git_instance_status)"
    scratch_git_id_before_wake="$(scratch_git_instance_id)"
    if [ -z "$scratch_git_status_before_wake" ] || [ -z "$scratch_git_id_before_wake" ]; then
        die "couldn't read the $SCRATCH_GIT_INSTANCE_NAME VM, so nothing was changed."
    fi

    load_slack_webhook_url_once
    operation_in_flight_description="Waking test"
    notify_slack ":alarm_clock: Waking test."

    echo "Starting the database and the scratch-git VM..."
    set_primary_database_activation_policy ALWAYS &
    database_start_process_id=$!
    if [ "$scratch_git_status_before_wake" = "RUNNING" ]; then
        echo "  $SCRATCH_GIT_INSTANCE_NAME: already running."
    else
        # A minute early, in case this machine's clock is ahead of the VM's. Only used if the boot time can't be read.
        scratch_git_start_requested_at="$(utc_timestamp_seconds_ago 60)"
        start_or_stop_scratch_git_instance start &
        scratch_git_start_process_id=$!
    fi
    wait "$database_start_process_id" || {
        echo "error: couldn't start $primary_database_instance_name." >&2
        any_start_failed=1
    }
    if [ -n "$scratch_git_start_process_id" ]; then
        wait "$scratch_git_start_process_id" || {
            echo "error: couldn't start $SCRATCH_GIT_INSTANCE_NAME." >&2
            any_start_failed=1
        }
    fi
    [ "$any_start_failed" = "0" ] || die "the database or the scratch-git VM didn't start. Run this again."

    # The startup script matters for any recent boot, not only one this run started: if an earlier wake started the VM
    # and its startup script failed, a retry finds the VM running, and scratch-git can look healthy while its containers
    # aren't using the data disk.
    scratch_git_boot_started_at="$(scratch_git_current_boot_started_at)"
    if [ -z "$scratch_git_boot_started_at" ] && [ -n "$scratch_git_start_process_id" ]; then
        scratch_git_boot_started_at="$scratch_git_start_requested_at"
    fi
    if [ -z "$scratch_git_boot_started_at" ]; then
        warn "couldn't read when the scratch-git VM booted, so its startup script wasn't checked. Relying on scratch-git's health check."
    elif [ -n "$scratch_git_start_process_id" ] ||
        [[ "$scratch_git_boot_started_at" > "$(utc_timestamp_seconds_ago "$RECENT_BOOT_WINDOW_SECONDS")" ]]; then
        echo "Waiting for the scratch-git VM's startup script (boot at $scratch_git_boot_started_at)..."
        wait_until_scratch_git_startup_script_finished "$scratch_git_id_before_wake" "$scratch_git_boot_started_at" ||
            startup_script_wait_result=$?
        case "$startup_script_wait_result" in
            0) ;;
            1) die "the scratch-git VM's startup script failed in its current boot, so its containers may not be using the data disk. The services were left paused. Read its output with 'gcloud compute instances get-serial-port-output $SCRATCH_GIT_INSTANCE_NAME --zone=$SCRATCH_GIT_INSTANCE_ZONE --project=$GCP_PROJECT_ID' or in Cloud Logging (GCEMetadataScripts), fix the cause, then pause and wake test to boot it again." ;;
            *) warn "no finished startup script showed up within ${STARTUP_SCRIPT_TIMEOUT_SECONDS}s. Relying on scratch-git's health check." ;;
        esac
    fi
    echo "Waiting for scratch-git to report healthy behind its load balancer..."
    wait_until_scratch_git_backend_is_healthy ||
        die "scratch-git didn't report healthy within ${SCRATCH_GIT_HEALTHY_TIMEOUT_SECONDS}s, so the services were left paused."

    echo "Waking ${SERVICES_WOKEN_FIRST}..."
    # shellcheck disable=SC2086 # word-splitting the service list is intended
    set_scaling_of_services_in_parallel auto $SERVICES_WOKEN_FIRST ||
        die "some services didn't wake."
    echo "Giving the worker ${WORKER_SETTLE_SECONDS_BEFORE_CRON}s to start before the cron's scheduler and reapers..."
    sleep "$WORKER_SETTLE_SECONDS_BEFORE_CRON"
    echo "Waking ${SERVICES_WOKEN_LAST}..."
    # shellcheck disable=SC2086 # word-splitting the service list is intended
    set_scaling_of_services_in_parallel auto $SERVICES_WOKEN_LAST ||
        die "$SERVICES_WOKEN_LAST didn't wake."
    echo "Waiting for the API to report healthy..."
    wait_until_api_is_healthy ||
        die "the API didn't report healthy within ${API_HEALTHY_TIMEOUT_SECONDS}s. Is Postgres accepting connections? api exits at boot when it isn't."

    end_the_alert_snooze
    operation_in_flight_description=""
    echo "Test is awake, in $(duration_since "$wake_started_at_seconds")."
    notify_slack ":sunny: Test is awake, in $(duration_since "$wake_started_at_seconds")."
}

command_pause() {
    local pause_started_at_seconds=$SECONDS scratch_git_status_before_pause database_stop_process_id
    local scratch_git_stop_process_id="" any_stop_failed=0
    require_gcloud_with_scaling_flag
    require_identity_that_can_change_test
    require_test_not_in_maintenance_mode
    load_primary_database_instance_name
    scratch_git_status_before_pause="$(scratch_git_instance_status)"
    [ -n "$scratch_git_status_before_pause" ] ||
        die "couldn't read the $SCRATCH_GIT_INSTANCE_NAME VM, so nothing was changed."

    load_slack_webhook_url_once
    operation_in_flight_description="Pausing test"
    notify_slack ":double_vertical_bar: Pausing test."

    echo "Snoozing the alerts a pause trips..."
    snooze_the_alerts_a_pause_trips
    echo "Pausing the services that add work: ${SERVICES_THAT_ADD_WORK_IN_PAUSE_ORDER}"
    # shellcheck disable=SC2086 # word-splitting the service list is intended
    set_scaling_of_services_in_parallel 0 $SERVICES_THAT_ADD_WORK_IN_PAUSE_ORDER ||
        die "some services didn't pause, so the worker, scratch-git, and the database were left running. Run this again."
    echo "Pausing the worker: ${SERVICES_THAT_DO_THE_WORK_IN_PAUSE_ORDER}"
    # shellcheck disable=SC2086 # word-splitting the service list is intended
    set_scaling_of_services_in_parallel 0 $SERVICES_THAT_DO_THE_WORK_IN_PAUSE_ORDER ||
        die "the worker didn't pause, so scratch-git and the database were left running. Run this again."
    echo "Giving scratch-git ${SCRATCH_GIT_DRAIN_SECONDS}s to finish in-flight requests..."
    sleep "$SCRATCH_GIT_DRAIN_SECONDS"

    echo "Stopping the scratch-git VM and the database..."
    if [ "$scratch_git_status_before_pause" = "TERMINATED" ]; then
        echo "  $SCRATCH_GIT_INSTANCE_NAME: already stopped."
    else
        start_or_stop_scratch_git_instance stop &
        scratch_git_stop_process_id=$!
    fi
    set_primary_database_activation_policy NEVER &
    database_stop_process_id=$!
    if [ -n "$scratch_git_stop_process_id" ]; then
        wait "$scratch_git_stop_process_id" || {
            echo "error: couldn't stop $SCRATCH_GIT_INSTANCE_NAME." >&2
            any_stop_failed=1
        }
    fi
    wait "$database_stop_process_id" || {
        echo "error: couldn't stop $primary_database_instance_name." >&2
        any_stop_failed=1
    }
    [ "$any_stop_failed" = "0" ] || die "the scratch-git VM or the database didn't stop. Run this again."

    operation_in_flight_description=""
    echo "Test is paused, in $(duration_since "$pause_started_at_seconds")."
    notify_slack ":zzz: Test is paused, in $(duration_since "$pause_started_at_seconds")."
}

main() {
    local required_tool
    for required_tool in gcloud jq curl; do
        command -v "$required_tool" >/dev/null 2>&1 || die "'$required_tool' is required but not installed."
    done
    case "${1:-}" in
        status) command_status ;;
        wake) command_wake ;;
        pause) command_pause ;;
        *) usage ;;
    esac
}

main "$@"
