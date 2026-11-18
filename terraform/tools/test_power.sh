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
# Every wake, including one that finds nothing paused, ends by asking the API's /service-check whether the API can
# actually reach Redis and both scratch-git ports. A running VM and a healthy load balancer don't prove that: the load
# balancer only opens a TCP connection to nginx, which stays up even when the scratch-git process behind it has hung.
# When scratch-git doesn't answer, a wake fails, so nothing goes on to test against a broken stack. `wake --before-deploy`
# only warns instead: the master pipeline uses it, because its own scratch-git deploy restarts scratch-git, and failing
# the wake would skip that deploy.
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
#   ./test_power.sh status                 # show each service's scaling, the database, the VM, scratch-git's health,
#                                          # whether the API can reach scratch-git, and the snooze
#   ./test_power.sh wake                   # if anything is paused: start the database and the VM, then the services.
#                                          # Then fail unless the API can reach scratch-git.
#   ./test_power.sh wake --before-deploy   # the same, but only warn when the API can't reach scratch-git
#   ./test_power.sh pause                  # snooze the alerts, stop the services, then the VM and the database

usage() {
    echo "usage: $0 status | wake [--before-deploy] | pause" >&2
    exit 1
}

GCP_PROJECT_ID="spv1eu-test"
CLOUD_RUN_REGION="europe-west1"
SCRATCH_GIT_INSTANCE_NAME="scratch-git"
SCRATCH_GIT_INSTANCE_ZONE="europe-west1-b"
# The internal TCP load balancer's backend in front of the scratch-git VM (terraform/modules/scratch_git_gce/main.tf).
SCRATCH_GIT_BACKEND_SERVICE_NAME="scratch-git-backend-service"
API_HEALTH_URL="https://test-api.scratch.md/health"
# Reports whether the API can reach each service it depends on (server/src/health/health.controller.ts). The API probes
# scratch-git's /health on both of its ports with a 5 s timeout, so a hung scratch-git shows up here as an error.
API_SERVICE_CHECK_URL="https://test-api.scratch.md/service-check"
# The /service-check components a wake requires to report "ok".
API_SERVICE_CHECK_REQUIRED_COMPONENTS="redis scratch_git scratch_git_http"

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
# What the guest agent logs when the startup script ends (see scratch_git_startup_script_outcome_lines_since), as awk
# regular expressions.
STARTUP_SCRIPT_FINISHED_PATTERN='Finished running startup scripts'
STARTUP_SCRIPT_FAILED_PATTERN='[Ss]cript "startup-script" failed with error.*|startup-script exit status [1-9][0-9]*'
# A wake checks the startup script whenever the VM booted this recently, even if this run didn't start it: an earlier
# wake that failed partway, and then retried, may have.
RECENT_BOOT_WINDOW_SECONDS=1800
SCRATCH_GIT_HEALTHY_TIMEOUT_SECONDS=300
API_HEALTHY_TIMEOUT_SECONDS=300
# How long a wake waits for /service-check to report every required component "ok". A freshly started API reaches a
# freshly booted scratch-git within seconds; this only covers a slow first request.
API_SERVICE_CHECK_TIMEOUT_SECONDS_AFTER_A_FULL_WAKE=180
# Shorter when nothing was paused: everything should already answer, and this wake runs in every master pipeline.
API_SERVICE_CHECK_TIMEOUT_SECONDS_WHEN_ALREADY_AWAKE=45

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

# The guest agent's own lines about how the startup script ended, since $2, each as "<UTC timestamp to the
# second><tab><line>", oldest first. The guest agent on the VM (google-guest-agent's gce_metadata_script_runner, version
# 20260715 in November 2026) logs:
#   - "Finished running startup scripts" once the script is done, whatever its outcome;
#   - 'Script "startup-script" failed with error: exit status N' just before that when the script exits non-zero, or
#     'run script "startup-script" failed with error: ...' when it couldn't start the script. A successful run logs
#     nothing else.
# Older guest agents logged "startup-script exit status N" whatever the outcome, so a non-zero one counts as a failure
# too. The agent logs each line of the script's own output as 'Metadata key("startup-script"), command("/bin/bash"):
# <line>'. Those lines are skipped, so the script's output is never printed and can't look like an outcome.
#
# It reads two places and prints whatever either one has:
#   - the serial console, where syslog lines start with an ISO 8601 UTC timestamp (2026-10-05T12:12:00.528360+00:00).
#     Only lines stamped at or after $2 count, so an earlier boot's lines never do, whether or not the console kept them
#     across the stop and start. Lines in any other format are ignored. It's immediate, but the API only returns the
#     last 1 MB;
#   - Cloud Logging (the guest agent's google_metadata_script_runner log, GCEMetadataScripts from older agents, or
#     syslog through the ops agent), from $2 on, which can lag a little.
# $1 = the instance id, $2 = the earliest UTC timestamp, as 2026-11-17T12:45:00Z.
scratch_git_startup_script_outcome_lines_since() {
    local instance_id="$1" earliest_timestamp="$2" serial_console_output cloud_logging_entries
    local outcome_pattern="$STARTUP_SCRIPT_FINISHED_PATTERN|$STARTUP_SCRIPT_FAILED_PATTERN"
    local log_filter="resource.type=\"gce_instance\" AND resource.labels.instance_id=\"$instance_id\""
    log_filter+=" AND (logName=\"projects/$GCP_PROJECT_ID/logs/google_metadata_script_runner\""
    log_filter+=" OR logName=\"projects/$GCP_PROJECT_ID/logs/GCEMetadataScripts\""
    log_filter+=" OR logName=\"projects/$GCP_PROJECT_ID/logs/syslog\")"
    log_filter+=" AND timestamp>=\"$earliest_timestamp\""
    log_filter+=" AND (\"Finished running startup scripts\" OR \"failed with error\" OR \"startup-script exit status\")"
    serial_console_output="$(gcloud_in_target_project compute instances get-serial-port-output \
        "$SCRATCH_GIT_INSTANCE_NAME" --zone="$SCRATCH_GIT_INSTANCE_ZONE" 2>/dev/null || true)"
    cloud_logging_entries="$(gcloud_in_target_project logging read "$log_filter" --limit=50 \
        --format='value(timestamp,jsonPayload.message,textPayload)' 2>/dev/null || true)"
    {
        printf '%s\n' "$serial_console_output" |
            awk -v earliest_timestamp="$earliest_timestamp" -v outcome_pattern="$outcome_pattern" '
                $1 ~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]/ &&
                substr($1, 1, 19) >= substr(earliest_timestamp, 1, 19) &&
                index($0, "Metadata key(") == 0 && $0 ~ outcome_pattern { print substr($1, 1, 19) "\t" $0 }'
        printf '%s\n' "$cloud_logging_entries" | awk -F '\t' -v outcome_pattern="$outcome_pattern" '
            { message = ($2 != "" ? $2 : $3) }
            $1 != "" && index(message, "Metadata key(") == 0 && message ~ outcome_pattern {
                print substr($1, 1, 19) "\t" message
            }'
    } | sort
}

# Waits for the VM's startup script, which runs on every boot, to finish. It mounts the data disk and recreates the
# scratch-git containers, and nothing may use scratch-git before it has: until then, Docker may already have restarted
# the old containers against the not-yet-mounted data directory, and the master pipeline's scratch-git deploy mustn't
# run alongside it. $1 = the instance id, $2 = when the current boot started, in UTC.
#
# Returns 0 when the script finished and no failure was logged in this boot, 1 when a failure was logged in this boot,
# and 2 when no finish showed up in time (the caller then relies on the health checks alone). A failure anywhere in the
# boot counts, even if someone ran the script again by hand afterwards: a successful run leaves no line to tell it
# apart, so only a new boot clears it.
wait_until_scratch_git_startup_script_finished() {
    local instance_id="$1" boot_started_at="$2" elapsed_seconds=0 startup_script_outcome_lines
    local startup_script_failure
    while [ "$elapsed_seconds" -le "$STARTUP_SCRIPT_TIMEOUT_SECONDS" ]; do
        startup_script_outcome_lines="$(scratch_git_startup_script_outcome_lines_since "$instance_id" "$boot_started_at")"
        startup_script_failure="$(printf '%s\n' "$startup_script_outcome_lines" |
            awk -F '\t' -v failed_pattern="$STARTUP_SCRIPT_FAILED_PATTERN" '
                match($2, failed_pattern) { failure = substr($2, RSTART) } END { print failure }')"
        if [ -n "$startup_script_failure" ]; then
            echo "  The startup script failed in this boot: $startup_script_failure"
            return 1
        fi
        case "$startup_script_outcome_lines" in
            *"$STARTUP_SCRIPT_FINISHED_PATTERN"*)
                echo "  The startup script finished, and no failure was logged."
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

# Prints one line for each of API_SERVICE_CHECK_REQUIRED_COMPONENTS that /service-check doesn't report as "ok", as
# "<component>: <status>: <error>", or one line saying why /service-check itself couldn't be read. Prints nothing when the
# API reaches every required service.
api_service_check_problems() {
    local response_file http_status_code
    response_file="$(mktemp)"
    # 60 s: test's api-service scales to 0 when idle, and a cold start took 23 s on 2026-11-17.
    http_status_code="$(curl --silent --output "$response_file" --write-out '%{http_code}' --max-time 60 \
        "$API_SERVICE_CHECK_URL" 2>/dev/null || true)"
    if [ "$http_status_code" != "200" ]; then
        case "$http_status_code" in
            "" | 000) echo "/service-check: no response" ;;
            *) echo "/service-check: HTTP $http_status_code" ;;
        esac
    elif ! jq -r --arg required_components "$API_SERVICE_CHECK_REQUIRED_COMPONENTS" '
        . as $response
        | $required_components | split(" ")[]
        | . as $component_name
        | ($response[$component_name] // {}) as $component
        | select(($component.status // "missing") != "ok")
        | "\($component_name): \($component.status // "missing")"
            + (if $component.error then ": \($component.error | tostring | gsub("[\\r\\n]+"; " ") | .[0:200])"
               else "" end)' "$response_file" 2>/dev/null; then
        echo "/service-check: the response wasn't JSON"
    fi
    rm -f "$response_file"
}

# Polls /service-check until every required component reports "ok", for up to $1 seconds. Leaves the last problems, one
# per line, in last_api_service_check_problems. Must be called directly, not inside $(...), so they survive.
last_api_service_check_problems=""
wait_until_the_api_reaches_every_required_service() {
    local timeout_seconds="$1" elapsed_seconds=0
    while true; do
        last_api_service_check_problems="$(api_service_check_problems)"
        if [ -z "$last_api_service_check_problems" ]; then
            echo "  ${elapsed_seconds}s: $API_SERVICE_CHECK_URL -> ok ($API_SERVICE_CHECK_REQUIRED_COMPONENTS)"
            return 0
        fi
        echo "  ${elapsed_seconds}s: $API_SERVICE_CHECK_URL -> $(joined_on_one_line "$last_api_service_check_problems")"
        [ "$elapsed_seconds" -lt "$timeout_seconds" ] || return 1
        sleep "$POLL_INTERVAL_SECONDS"
        elapsed_seconds=$((elapsed_seconds + POLL_INTERVAL_SECONDS))
    done
}

# Prints $1's lines joined with "; ".
joined_on_one_line() {
    printf '%s\n' "$1" | awk 'NF { printf "%s%s", (joined_count++ ? "; " : ""), $0 }'
}

# Ends a wake by checking, through /service-check, that the API can reach Redis and both scratch-git ports, for up to
# $1 seconds. A running VM and a healthy load balancer don't prove that: the load balancer only opens a TCP connection to
# nginx, which stays up when the scratch-git process behind it has hung. Fails the wake when the API can't, unless the
# wake runs before a deploy (--before-deploy): that pipeline's own scratch-git deploy restarts scratch-git, and failing
# here would skip it, so then it only warns.
require_the_api_to_reach_every_required_service() {
    local timeout_seconds="$1" problem_summary recovery_hint=""
    echo "Checking that the API can reach Redis and scratch-git..."
    if wait_until_the_api_reaches_every_required_service "$timeout_seconds"; then
        return 0
    fi
    problem_summary="$(joined_on_one_line "$last_api_service_check_problems")"
    if [ "$(maintenance_lockdown_state)" = "ON" ]; then
        problem_summary+=". Test is in maintenance mode, and its lockdown blocks /service-check"
    fi
    case "$last_api_service_check_problems" in
        *scratch_git*)
            recovery_hint=" The scratch-git process may have hung: its VM and load balancer can look healthy while it answers nothing. Retry the 'deploy scratch-git to test environment' job of the latest master pipeline, which restarts it, then run this wake again."
            ;;
    esac
    if [ "$wake_runs_before_a_deploy" = "true" ]; then
        warn "the API can't reach every service it needs after ${timeout_seconds}s: $problem_summary. This pipeline's scratch-git deploy restarts scratch-git, so the wake goes on."
        notify_slack ":warning: *The test API can't reach every service it needs:* $problem_summary. This master pipeline's scratch-git deploy should restart scratch-git; if its post-deploy environment tests still fail, check scratch-git."
        return 0
    fi
    die "the API can't reach every service it needs after ${timeout_seconds}s: ${problem_summary}.${recovery_hint}"
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
    local active_snooze_names active_snooze_name snooze_cancel_output
    if ! active_snooze_names="$(active_test_is_paused_snooze_names)"; then
        warn "couldn't list the alert snoozes, so they weren't ended."
        return 0
    fi
    for active_snooze_name in $active_snooze_names; do
        if snooze_cancel_output="$(gcloud_in_target_project monitoring snoozes cancel "$active_snooze_name" \
            --format=none 2>&1)"; then
            echo "  Ended the alert snooze."
        else
            case "$snooze_cancel_output" in
                # Another wake (a manual one, say) ended it between the list and the cancel.
                *"already ended"* | *"was canceled"*) echo "  The alert snooze had already ended." ;;
                *) warn "couldn't end the alert snooze $active_snooze_name: $snooze_cancel_output" ;;
            esac
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
    local service_name snooze_line="not snoozed" active_snooze_names api_service_check_problems_now
    load_primary_database_instance_name
    for service_name in $ALL_PAUSED_SERVICES; do
        printf '%-30s %s\n' "$service_name" "$(cloud_run_service_status_line "$service_name")"
    done
    printf '%-30s %s\n' "$primary_database_instance_name" "$(primary_database_status_line)"
    printf '%-30s %s\n' "$SCRATCH_GIT_INSTANCE_NAME" \
        "$(scratch_git_instance_status | sed -e 's/^TERMINATED$/PAUSED (TERMINATED)/' -e 's/^$/unreadable/')"
    printf '%-30s %s\n' "$SCRATCH_GIT_BACKEND_SERVICE_NAME" "$(scratch_git_backend_health_state | sed 's/^$/unreadable/')"
    api_service_check_problems_now="$(api_service_check_problems)"
    if [ -z "$api_service_check_problems_now" ]; then
        printf '%-30s %s\n' "api /service-check" "ok ($API_SERVICE_CHECK_REQUIRED_COMPONENTS)"
    else
        printf '%-30s %s\n' "api /service-check" "$(joined_on_one_line "$api_service_check_problems_now")"
    fi
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
        echo "Nothing is paused."
        # Set so that a failure below posts to Slack, which this quiet path otherwise doesn't.
        operation_in_flight_description="Checking that test is awake"
        require_the_api_to_reach_every_required_service "$API_SERVICE_CHECK_TIMEOUT_SECONDS_WHEN_ALREADY_AWAKE"
        operation_in_flight_description=""
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
        warn "couldn't read when the scratch-git VM booted, so its startup script wasn't checked. Relying on the health checks."
    elif [ -n "$scratch_git_start_process_id" ] ||
        [[ "$scratch_git_boot_started_at" > "$(utc_timestamp_seconds_ago "$RECENT_BOOT_WINDOW_SECONDS")" ]]; then
        echo "Waiting for the scratch-git VM's startup script (boot at $scratch_git_boot_started_at)..."
        wait_until_scratch_git_startup_script_finished "$scratch_git_id_before_wake" "$scratch_git_boot_started_at" ||
            startup_script_wait_result=$?
        case "$startup_script_wait_result" in
            0) ;;
            1) die "the scratch-git VM's startup script failed in its current boot, so its containers may not be using the data disk. The services were left paused. Read its output with 'gcloud compute instances get-serial-port-output $SCRATCH_GIT_INSTANCE_NAME --zone=$SCRATCH_GIT_INSTANCE_ZONE --project=$GCP_PROJECT_ID' or in Cloud Logging (google_metadata_script_runner), fix the cause, then pause and wake test to boot it again." ;;
            *) warn "no finished startup script showed up within ${STARTUP_SCRIPT_TIMEOUT_SECONDS}s. Relying on the health checks." ;;
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
    require_the_api_to_reach_every_required_service "$API_SERVICE_CHECK_TIMEOUT_SECONDS_AFTER_A_FULL_WAKE"

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

# Set by `wake --before-deploy`: the caller deploys test right after this wake (the master pipeline's `wake test`), and
# that deploy restarts scratch-git, so an API that can't reach scratch-git only warns.
wake_runs_before_a_deploy="false"

main() {
    local required_tool command_name="${1:-}"
    [ $# -eq 0 ] || shift
    for required_tool in gcloud jq curl; do
        command -v "$required_tool" >/dev/null 2>&1 || die "'$required_tool' is required but not installed."
    done
    case "$command_name" in
        status)
            [ $# -eq 0 ] || usage
            command_status
            ;;
        wake)
            while [ $# -gt 0 ]; do
                case "$1" in
                    --before-deploy) wake_runs_before_a_deploy="true" ;;
                    *) usage ;;
                esac
                shift
            done
            command_wake
            ;;
        pause)
            [ $# -eq 0 ] || usage
            command_pause
            ;;
        *) usage ;;
    esac
}

main "$@"
