#!/bin/bash
set -euo pipefail

# Scratch maintenance mode.
#
# Layer 1 (lockdown): flips a Cloud Armor rule on the client and api load balancers so the public gets a 503
#   maintenance page / JSON error, while an IP allowlist still reaches the real backends.
# Layer 2 (quiesce): switches api-service, worker-service and cron-service to manual scaling with 0 instances so
#   nothing touches Postgres, Redis or scratch-git during the window.
#
# Both layers are GCP control-plane changes: no Terraform apply, no new Cloud Run revision, no Postgres/Redis.
# Slack is told when a window starts, when it is fully active, and when it ends (see "Slack notifications" below).
# Full procedure, checklists and what each audience sees: docs/ops/runbook-maintenance-mode.md

usage() {
    cat <<USAGE
usage: $0 <test|production> <command> [flags]

commands:
  status            Show lockdown state, bypass allowlist, backend scaling, and live probes of both hosts.
  on                Lock down both load balancers, then scale cron, worker and api to 0 instances.
  resume-backends   Scale api, worker and cron back to automatic. Lockdown stays on so a bypassed dev can verify.
  off               Resume backends if needed, verify API health, then reopen both load balancers.

flags for 'on':
  --allow-ip <cidr[,cidr...]|none>   Source IPs that bypass the lockdown (max 10). Default: your public IPv4.
  --lockdown-only                    Block public traffic but leave the backends running.
  --preview                          Dry run: log would-be denials without blocking anything. Clear with 'off'.

flags for 'on', 'resume-backends' and 'off':
  --no-notify                        Do not post to Slack. By default the script posts to the webhook stored in the
                                     environment's SLACK_NOTIFICATION_WEBHOOK_URL secret.

Runbook: docs/ops/runbook-maintenance-mode.md
USAGE
}

last_error_message=""

die() {
    last_error_message="$*"
    echo "Error: $*" >&2
    exit 1
}

## ---------------------------------------------------------------------------------------------------------------------
## Arguments and derived names
## ---------------------------------------------------------------------------------------------------------------------

if [ $# -lt 2 ]; then
    usage
    exit 1
fi

environment_short_name="$1"
command_name="$2"
shift 2

case "$environment_short_name" in
    test)
        client_host="test.scratch.md"
        api_host="test-api.scratch.md"
        ;;
    production)
        client_host="app.scratch.md"
        api_host="api.scratch.md"
        ;;
    *)
        usage
        exit 1
        ;;
esac

bypass_cidrs_requested_by_flag=""
lockdown_only="false"
preview_only="false"
slack_notifications_enabled="true"

while [ $# -gt 0 ]; do
    case "$1" in
        --allow-ip)
            [ $# -ge 2 ] || die "--allow-ip needs a value"
            bypass_cidrs_requested_by_flag="$2"
            shift 2
            ;;
        --allow-ip=*)
            bypass_cidrs_requested_by_flag="${1#--allow-ip=}"
            shift
            ;;
        --lockdown-only)
            lockdown_only="true"
            shift
            ;;
        --preview)
            preview_only="true"
            shift
            ;;
        --no-notify)
            slack_notifications_enabled="false"
            shift
            ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            usage
            exit 1
            ;;
    esac
done

gcp_project_id="spv1eu-${environment_short_name}"
terraform_env_name="eu-${environment_short_name}"
cloud_run_region="europe-west1"

security_policy_name="${terraform_env_name}-maintenance"
client_url_map_name="${terraform_env_name}-client-url-map"
api_url_map_name="${terraform_env_name}-api-url-map"
client_backend_service_name="${terraform_env_name}-client-backend"
api_backend_service_name="${terraform_env_name}-api-backend"

BYPASS_RULE_PRIORITY=100
LOCKDOWN_RULE_PRIORITY=1000
LOCKDOWN_DENY_ACTION_FLAG="deny-502"    # gcloud flag spelling
LOCKDOWN_DENY_ACTION_VALUE="deny(502)"  # what 'describe' reports
BYPASS_PLACEHOLDER_CIDR="192.0.2.1/32"  # RFC 5737 documentation address; never matches real traffic
MAX_BYPASS_CIDRS=10

PROPAGATION_POLL_INTERVAL_SECONDS=10
PROPAGATION_TIMEOUT_SECONDS=600
API_HEALTHY_TIMEOUT_SECONDS=300
# Pause between resuming one backend and the next, so the BullMQ worker exists before the scheduler and reapers on
# the cron service start producing and reconciling work.
BACKEND_RESUME_SETTLE_SECONDS=45

SLACK_WEBHOOK_SECRET_NAME="SLACK_NOTIFICATION_WEBHOOK_URL"
SLACK_REQUEST_TIMEOUT_SECONDS=10

# The scheduler and reapers (cron) stop first, then the job consumer (worker), then the API.
BACKEND_SERVICES_IN_QUIESCE_ORDER="cron-service worker-service api-service"
BACKEND_SERVICES_IN_RESUME_ORDER="api-service worker-service cron-service"

## ---------------------------------------------------------------------------------------------------------------------
## gcloud helpers
## ---------------------------------------------------------------------------------------------------------------------

# --billing-project keeps quota attribution on the target project, which the per-dev read-only identities need even
# for the read-only 'status' command.
gcloud_in_target_project() {
    gcloud "$@" --project="$gcp_project_id" --billing-project="$gcp_project_id"
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

require_identity_that_can_change_infrastructure() {
    local identity
    identity="$(effective_gcloud_identity)"
    echo "gcloud identity: $identity"
    case "$identity" in
        *-readonly@*)
            die "'$identity' is a read-only identity. Flipping maintenance mode needs a role_operations@ identity (gcloud auth login, and unset auth/impersonate_service_account)."
            ;;
    esac
}

security_policy_rule_field() {
    local rule_priority="$1" field_expression="$2"
    gcloud_in_target_project compute security-policies rules describe "$rule_priority" \
        --security-policy="$security_policy_name" --format="value(${field_expression})" 2>/dev/null || true
}

# Prints one of: ON, PREVIEW, OFF, UNKNOWN
lockdown_state() {
    local rule_action rule_preview
    rule_action="$(security_policy_rule_field "$LOCKDOWN_RULE_PRIORITY" "action")"
    rule_preview="$(security_policy_rule_field "$LOCKDOWN_RULE_PRIORITY" "preview")"
    if [ -z "$rule_action" ]; then
        echo "UNKNOWN"
    elif [ "$rule_action" = "$LOCKDOWN_DENY_ACTION_VALUE" ] && [ "$rule_preview" = "True" ]; then
        echo "PREVIEW"
    elif [ "$rule_action" = "$LOCKDOWN_DENY_ACTION_VALUE" ]; then
        echo "ON"
    else
        echo "OFF"
    fi
}

current_bypass_cidrs() {
    security_policy_rule_field "$BYPASS_RULE_PRIORITY" "match.config.srcIpRanges.list()"
}

set_bypass_cidrs() {
    local comma_separated_cidrs="$1" rule_description="$2"
    gcloud_in_target_project compute security-policies rules update "$BYPASS_RULE_PRIORITY" \
        --security-policy="$security_policy_name" \
        --src-ip-ranges="$comma_separated_cidrs" \
        --description="$rule_description" >/dev/null
}

# $1 = gcloud action flag value, $2 = --preview or --no-preview, $3 = description
set_lockdown_rule() {
    gcloud_in_target_project compute security-policies rules update "$LOCKDOWN_RULE_PRIORITY" \
        --security-policy="$security_policy_name" \
        --action="$1" "$2" \
        --description="$3" >/dev/null
}

cloud_run_service_annotation() {
    local service_name="$1" annotation_key="$2"
    gcloud_in_target_project run services describe "$service_name" --region="$cloud_run_region" \
        --format="value(metadata.annotations.\"${annotation_key}\")" 2>/dev/null || true
}

cloud_run_service_is_scaled_to_zero() {
    local service_name="$1" scaling_mode manual_instance_count
    scaling_mode="$(cloud_run_service_annotation "$service_name" "run.googleapis.com/scalingMode")"
    manual_instance_count="$(cloud_run_service_annotation "$service_name" "run.googleapis.com/manualInstanceCount")"
    [ "$scaling_mode" = "manual" ] && [ "$manual_instance_count" = "0" ]
}

cloud_run_service_scaling_summary() {
    local service_name="$1" scaling_mode manual_instance_count
    scaling_mode="$(cloud_run_service_annotation "$service_name" "run.googleapis.com/scalingMode")"
    manual_instance_count="$(cloud_run_service_annotation "$service_name" "run.googleapis.com/manualInstanceCount")"
    if [ "$scaling_mode" = "manual" ]; then
        echo "manual, ${manual_instance_count:-?} instance(s)"
    else
        echo "automatic"
    fi
}

# $2 = 0 or auto. Service-level setting: takes effect without creating a revision.
set_cloud_run_service_scaling() {
    local service_name="$1" scaling_value="$2"
    gcloud_in_target_project run services update "$service_name" --region="$cloud_run_region" \
        --scaling="$scaling_value" --quiet >/dev/null ||
        die "could not set --scaling=$scaling_value on $service_name. If gcloud rejected the --scaling flag, run 'gcloud components update'."
}

any_backend_is_scaled_to_zero() {
    local service_name
    for service_name in $BACKEND_SERVICES_IN_RESUME_ORDER; do
        if cloud_run_service_is_scaled_to_zero "$service_name"; then
            return 0
        fi
    done
    return 1
}

## ---------------------------------------------------------------------------------------------------------------------
## Probes
## ---------------------------------------------------------------------------------------------------------------------

# A unique query string guarantees a CDN cache miss, so the probe reflects the security policy and not the cache.
http_status_code_for_url() {
    local url="$1"
    shift
    local status_code
    status_code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 10 "$@" \
        "${url}?maintenance_probe=$(date +%s)" 2>/dev/null)" || true
    echo "${status_code:-000}"
}

client_host_status_code() { http_status_code_for_url "https://${client_host}/"; }
api_host_status_code() { http_status_code_for_url "https://${api_host}/health"; }

status_code_means_unavailable() {
    case "$1" in 5??) return 0 ;; *) return 1 ;; esac
}

# The client root answers a signed-out request with a redirect to sign-in, so 3xx also means "open".
status_code_means_open() {
    case "$1" in 2?? | 3??) return 0 ;; *) return 1 ;; esac
}

caller_public_ipv4() {
    local detected_ip
    detected_ip="$(curl -4 --silent --max-time 5 https://api.ipify.org 2>/dev/null || true)"
    if echo "$detected_ip" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
        echo "$detected_ip"
    fi
}

caller_is_in_bypass_allowlist() {
    local caller_ip
    caller_ip="$(caller_public_ipv4)"
    [ -n "$caller_ip" ] || return 1
    # Exact /32 match only; a caller covered by a wider CIDR is reported as not bypassed, which is the safe answer.
    echo ",$(current_bypass_cidrs)," | grep -q ",${caller_ip}/32,"
}

# $1 = "unavailable" or "open". Polls both hosts until they agree or the timeout passes.
wait_until_both_hosts_are() {
    local wanted_state="$1" elapsed_seconds=0 client_code api_code
    while [ "$elapsed_seconds" -le "$PROPAGATION_TIMEOUT_SECONDS" ]; do
        client_code="$(client_host_status_code)"
        api_code="$(api_host_status_code)"
        echo "  ${elapsed_seconds}s: ${client_host} -> ${client_code}, ${api_host} -> ${api_code}"
        if [ "$wanted_state" = "unavailable" ]; then
            if status_code_means_unavailable "$client_code" && status_code_means_unavailable "$api_code"; then
                return 0
            fi
        else
            if status_code_means_open "$client_code" && [ "$api_code" = "200" ]; then
                return 0
            fi
        fi
        sleep "$PROPAGATION_POLL_INTERVAL_SECONDS"
        elapsed_seconds=$((elapsed_seconds + PROPAGATION_POLL_INTERVAL_SECONDS))
    done
    return 1
}

wait_until_api_is_healthy() {
    local elapsed_seconds=0 api_code
    while [ "$elapsed_seconds" -le "$API_HEALTHY_TIMEOUT_SECONDS" ]; do
        api_code="$(api_host_status_code)"
        echo "  ${elapsed_seconds}s: ${api_host}/health -> ${api_code}"
        if [ "$api_code" = "200" ]; then
            return 0
        fi
        sleep "$PROPAGATION_POLL_INTERVAL_SECONDS"
        elapsed_seconds=$((elapsed_seconds + PROPAGATION_POLL_INTERVAL_SECONDS))
    done
    return 1
}

## ---------------------------------------------------------------------------------------------------------------------
## Slack notifications
## ---------------------------------------------------------------------------------------------------------------------

# The webhook URL is a credential. It is read from Secret Manager into memory, never printed, and handed to curl on
# stdin so it does not appear in the process list. Notifications never fail the caller: a maintenance window must not
# depend on Slack.
slack_webhook_url=""
slack_webhook_url_load_was_attempted="false"

# Must be called directly, not inside $(...), so the loaded value survives.
load_slack_webhook_url_once() {
    if [ "$slack_webhook_url_load_was_attempted" = "true" ]; then
        return 0
    fi
    slack_webhook_url_load_was_attempted="true"
    slack_webhook_url="$(gcloud_in_target_project secrets versions access latest --secret="$SLACK_WEBHOOK_SECRET_NAME" 2>/dev/null || true)"
    case "$slack_webhook_url" in
        https://hooks.slack.com/*) ;;
        "")
            echo "  warning: could not read the $SLACK_WEBHOOK_SECRET_NAME secret in $gcp_project_id. Continuing WITHOUT Slack notifications."
            ;;
        *)
            slack_webhook_url=""
            echo "  warning: the $SLACK_WEBHOOK_SECRET_NAME secret in $gcp_project_id is not a Slack webhook URL. Continuing WITHOUT Slack notifications."
            ;;
    esac
}

# Escapes backslashes and double quotes, and turns real newlines into \n, so the value is safe inside a JSON string.
json_string_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{ printf "%s%s", (NR > 1 ? "\\n" : ""), $0 }'
}

# $1 = message in Slack mrkdwn. Same {"text": ...} payload the server's SlackNotificationService sends.
send_slack_notification() {
    local message_text="$1" request_payload response_status_code
    [ "$slack_notifications_enabled" = "true" ] || return 0
    load_slack_webhook_url_once
    [ -n "$slack_webhook_url" ] || return 0
    request_payload="{\"text\":\"$(json_string_escape "$message_text")\"}"
    response_status_code="$(printf 'url = "%s"\n' "$slack_webhook_url" | curl --config - --silent --output /dev/null \
        --write-out '%{http_code}' --max-time "$SLACK_REQUEST_TIMEOUT_SECONDS" --request POST \
        --header 'Content-Type: application/json' --data "$request_payload" 2>/dev/null)" || true
    if [ "$response_status_code" = "200" ]; then
        echo "  Slack notified."
    else
        echo "  warning: the Slack notification was not delivered (HTTP ${response_status_code:-none}). Continuing."
    fi
}

# Set while an operation that Slack was told about is in flight, so an unexpected exit is reported too.
slack_operation_in_flight_description=""

notify_slack_if_operation_did_not_complete() {
    local script_exit_status=$?
    if [ "$script_exit_status" -ne 0 ] && [ -n "$slack_operation_in_flight_description" ]; then
        send_slack_notification ":warning: *${slack_operation_in_flight_description} did NOT complete on ${environment_short_name}.* ${last_error_message:-The script exited unexpectedly.}
Lockdown state now: $(lockdown_state). Check \`maintenance_mode.sh ${environment_short_name} status\` before doing anything else."
    fi
}
trap notify_slack_if_operation_did_not_complete EXIT

## ---------------------------------------------------------------------------------------------------------------------
## Shared steps
## ---------------------------------------------------------------------------------------------------------------------

confirm_or_exit() {
    local prompt_summary="$1" typed_reply
    echo
    echo "$prompt_summary"
    if [ "$environment_short_name" = "production" ]; then
        read -r -p "Type 'production' to confirm: " typed_reply || die "no confirmation received; nothing further was changed"
        [ "$typed_reply" = "production" ] || {
            echo "Cancelled."
            exit 0
        }
    else
        read -r -p "Continue? [y/N] " typed_reply || die "no confirmation received; nothing further was changed"
        case "$typed_reply" in
            y | Y) ;;
            *)
                echo "Cancelled."
                exit 0
                ;;
        esac
    fi
}

change_stamp() {
    echo "by $(effective_gcloud_identity) at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
}

# Turns the --allow-ip value into a validated, comma-separated CIDR list. Empty output means "no bypass".
resolve_bypass_cidrs() {
    local requested="$bypass_cidrs_requested_by_flag" resolved="" entry cidr_count=0
    if [ "$requested" = "none" ]; then
        return 0
    fi
    if [ -z "$requested" ]; then
        requested="$(caller_public_ipv4)"
        [ -n "$requested" ] || die "could not detect your public IPv4. Pass --allow-ip <cidr> or --allow-ip none."
    fi
    for entry in $(echo "$requested" | tr ',' ' '); do
        echo "$entry" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}(/[0-9]{1,2})?$' || die "'$entry' is not an IPv4 address or CIDR"
        case "$entry" in */*) ;; *) entry="${entry}/32" ;; esac
        resolved="${resolved:+${resolved},}${entry}"
        cidr_count=$((cidr_count + 1))
    done
    [ "$cidr_count" -le "$MAX_BYPASS_CIDRS" ] || die "Cloud Armor allows at most ${MAX_BYPASS_CIDRS} CIDRs per rule"
    echo "$resolved"
}

require_terraform_managed_policy() {
    [ "$(lockdown_state)" != "UNKNOWN" ] ||
        die "security policy '$security_policy_name' (rule $LOCKDOWN_RULE_PRIORITY) was not found in $gcp_project_id. Has the maintenance-mode Terraform been applied, and can this identity read it?"
}

resume_backends() {
    local service_name lockdown_state_now
    lockdown_state_now="$(lockdown_state)"
    for service_name in $BACKEND_SERVICES_IN_RESUME_ORDER; do
        echo "Scaling $service_name back to automatic..."
        set_cloud_run_service_scaling "$service_name" "auto"
        if [ "$service_name" = "api-service" ]; then
            # The API is only reachable from here if the load balancer is open or this machine is bypassed.
            if [ "$lockdown_state_now" != "ON" ] || caller_is_in_bypass_allowlist; then
                echo "Waiting for the API to report healthy..."
                wait_until_api_is_healthy ||
                    die "the API did not become healthy within ${API_HEALTHY_TIMEOUT_SECONDS}s. Is Postgres accepting connections? New instances exit at boot when it is not. worker-service and cron-service were left at 0."
            else
                echo "This machine is not in the bypass allowlist, so API health cannot be probed. Settling for ${BACKEND_RESUME_SETTLE_SECONDS}s."
                sleep "$BACKEND_RESUME_SETTLE_SECONDS"
            fi
        elif [ "$service_name" = "worker-service" ]; then
            echo "Giving the worker ${BACKEND_RESUME_SETTLE_SECONDS}s to start before the scheduler and reapers resume..."
            sleep "$BACKEND_RESUME_SETTLE_SECONDS"
        fi
    done
    echo "Backends resumed."
}

## ---------------------------------------------------------------------------------------------------------------------
## Commands
## ---------------------------------------------------------------------------------------------------------------------

command_status() {
    local state caller_ip bypass_cidrs service_name
    state="$(lockdown_state)"
    caller_ip="$(caller_public_ipv4)"
    bypass_cidrs="$(current_bypass_cidrs)"

    echo "Environment:       $environment_short_name ($gcp_project_id)"
    echo "gcloud identity:   $(effective_gcloud_identity)"
    echo
    echo "Lockdown:          $state"
    if [ "$state" = "UNKNOWN" ]; then
        echo "  Security policy '$security_policy_name' was not readable. Has the Terraform been applied?"
    else
        printf '  %-18s %s\n' "rule $LOCKDOWN_RULE_PRIORITY:" "action=$(security_policy_rule_field "$LOCKDOWN_RULE_PRIORITY" "action") preview=$(security_policy_rule_field "$LOCKDOWN_RULE_PRIORITY" "preview")"
        printf '  %-18s %s\n' "last change:" "$(security_policy_rule_field "$LOCKDOWN_RULE_PRIORITY" "description")"
        printf '  %-18s %s\n' "bypass (rule $BYPASS_RULE_PRIORITY):" "${bypass_cidrs:-none}"
    fi
    if [ -n "$caller_ip" ]; then
        if caller_is_in_bypass_allowlist; then
            printf '  %-18s %s\n' "your public IPv4:" "$caller_ip (BYPASSED: the probes below show what you see, not what the public sees)"
        else
            printf '  %-18s %s\n' "your public IPv4:" "$caller_ip (not bypassed)"
        fi
    fi
    echo
    echo "Wiring (managed by Terraform):"
    printf '  %-44s %s\n' "$client_backend_service_name policy:" "$(gcloud_in_target_project compute backend-services describe "$client_backend_service_name" --global --format='value(securityPolicy.basename())' 2>/dev/null || echo unavailable)"
    printf '  %-44s %s\n' "$api_backend_service_name policy:" "$(gcloud_in_target_project compute backend-services describe "$api_backend_service_name" --global --format='value(securityPolicy.basename())' 2>/dev/null || echo unavailable)"
    printf '  %-44s %s\n' "$client_url_map_name error page:" "$(gcloud_in_target_project compute url-maps describe "$client_url_map_name" --global --format='value(defaultCustomErrorResponsePolicy.errorResponseRules[0].path)' 2>/dev/null || echo unavailable)"
    printf '  %-44s %s\n' "$api_url_map_name error body:" "$(gcloud_in_target_project compute url-maps describe "$api_url_map_name" --global --format='value(defaultCustomErrorResponsePolicy.errorResponseRules[0].path)' 2>/dev/null || echo unavailable)"
    echo
    echo "Backends:"
    for service_name in $BACKEND_SERVICES_IN_RESUME_ORDER; do
        printf '  %-44s %s\n' "$service_name:" "$(cloud_run_service_scaling_summary "$service_name")"
    done
    echo
    echo "Probes (cache-busted, from this machine):"
    printf '  %-58s -> %s\n' "https://${client_host}/" "$(client_host_status_code)"
    printf '  %-58s -> %s\n' "https://${api_host}/health" "$(api_host_status_code)"
    printf '  %-58s -> %s\n' "https://${api_host}/health (with Authorization header)" "$(http_status_code_for_url "https://${api_host}/health" --header 'Authorization: Bearer maintenance-probe')"
}

command_on() {
    local bypass_cidrs service_name bypass_summary_for_slack
    require_identity_that_can_change_infrastructure
    require_terraform_managed_policy

    if [ "$preview_only" = "true" ]; then
        confirm_or_exit "PREVIEW on $environment_short_name: would-be denials are logged for every request, but nothing is blocked and no backend is touched."
        set_lockdown_rule "$LOCKDOWN_DENY_ACTION_FLAG" "--preview" "PREVIEW $(change_stamp)"
        echo "Preview is set. Inspect the would-be denials with:"
        echo "  gcloud logging read 'resource.type=\"http_load_balancer\" AND jsonPayload.previewSecurityPolicy.name=\"${security_policy_name}\"' --project=$gcp_project_id --billing-project=$gcp_project_id --freshness=15m --limit=10"
        echo "Clear it with: $0 $environment_short_name off"
        return 0
    fi

    bypass_cidrs="$(resolve_bypass_cidrs)"

    echo "Current lockdown state: $(lockdown_state)"
    if [ "$lockdown_only" = "true" ]; then
        confirm_or_exit "This will BLOCK ALL PUBLIC TRAFFIC to ${client_host} and ${api_host}. Backends keep running. Bypass: ${bypass_cidrs:-none}."
    else
        confirm_or_exit "This will BLOCK ALL PUBLIC TRAFFIC to ${client_host} and ${api_host}, then STOP cron-service, worker-service and api-service (running jobs are interrupted and re-run on resume). Bypass: ${bypass_cidrs:-none}."
    fi

    slack_operation_in_flight_description="Turning maintenance mode ON"
    if [ "$lockdown_only" = "true" ]; then
        send_slack_notification ":construction: *Maintenance mode is starting on ${environment_short_name}* (${client_host}, ${api_host})
Started by $(effective_gcloud_identity). Public traffic is about to be blocked. Backends keep running (lockdown only)."
    else
        send_slack_notification ":construction: *Maintenance mode is starting on ${environment_short_name}* (${client_host}, ${api_host})
Started by $(effective_gcloud_identity). Public traffic is about to be blocked, then cron-service, worker-service and api-service will be stopped."
    fi

    # Bypass is cleared first so the propagation poll below sees what the public sees, even from a bypassed machine.
    echo "Clearing the bypass allowlist..."
    set_bypass_cidrs "$BYPASS_PLACEHOLDER_CIDR" "Maintenance bypass allowlist (empty)"

    echo "Turning lockdown on..."
    set_lockdown_rule "$LOCKDOWN_DENY_ACTION_FLAG" "--no-preview" "ON $(change_stamp)"

    echo "Invalidating the client CDN cache (cache hits skip the security policy)..."
    gcloud_in_target_project compute url-maps invalidate-cdn-cache "$client_url_map_name" --global --path='/*' --async >/dev/null 2>&1 ||
        echo "  warning: CDN invalidation failed; cached static assets may keep serving. Continuing."

    echo "Waiting for the lockdown to propagate (Cloud Armor changes can take a few minutes)..."
    wait_until_both_hosts_are "unavailable" ||
        die "both hosts were not blocked within ${PROPAGATION_TIMEOUT_SECONDS}s. The rule IS set to deny; check '$0 $environment_short_name status' before doing any maintenance. Backends were NOT stopped."

    if [ -n "$bypass_cidrs" ]; then
        echo "Setting the bypass allowlist to: $bypass_cidrs"
        set_bypass_cidrs "$bypass_cidrs" "Maintenance bypass allowlist, set $(change_stamp)"
    fi

    if [ -n "$bypass_cidrs" ]; then
        bypass_summary_for_slack="Bypass allowlist: $(echo "$bypass_cidrs" | tr ',' '\n' | wc -l | tr -d ' ') address range(s)."
    else
        bypass_summary_for_slack="No bypass allowlist."
    fi

    if [ "$lockdown_only" = "true" ]; then
        echo "Lockdown is ON. Backends were left running (--lockdown-only)."
        send_slack_notification ":lock: *Maintenance mode is ACTIVE on ${environment_short_name}.* Both hosts are verified blocked. Backends were left running (lockdown only). ${bypass_summary_for_slack}"
    else
        for service_name in $BACKEND_SERVICES_IN_QUIESCE_ORDER; do
            echo "Scaling $service_name to 0..."
            set_cloud_run_service_scaling "$service_name" "0"
        done
        echo "Lockdown is ON and the backends are stopped."
        send_slack_notification ":lock: *Maintenance mode is ACTIVE on ${environment_short_name}.* Both hosts are verified blocked, and cron-service, worker-service and api-service are stopped. ${bypass_summary_for_slack}"
    fi
    slack_operation_in_flight_description=""

    cat <<REMINDERS

Before you start the maintenance work:
  - Deploys must be held: a pipeline would run database migrations mid-window. Pause the AUTO_PUSH_PROD schedule and
    do not merge to the deploy branch for this environment.
  - Expect the desktop/CLI download uptime alerts (warn tier, Slack + email) to fire on production within ~10 minutes.
  - Taking Postgres, Redis or the scratch-git VM down pages on-call through the datastore alerts unless you snooze them.

When the work is done:
  1. $0 $environment_short_name resume-backends     (only once Postgres and Redis accept connections)
  2. Verify the app from a bypassed IP.
  3. $0 $environment_short_name off
REMINDERS
}

command_resume_backends() {
    require_identity_that_can_change_infrastructure
    confirm_or_exit "This will start api-service, worker-service and cron-service on $environment_short_name. Postgres and Redis must already accept connections, or new instances exit at boot."
    slack_operation_in_flight_description="Resuming the backends"
    resume_backends
    slack_operation_in_flight_description=""
    echo "Lockdown state is still: $(lockdown_state)"
}

command_off() {
    local state some_backend_is_stopped="false" api_health_can_be_verified="true" a_window_is_active="false"
    require_identity_that_can_change_infrastructure
    require_terraform_managed_policy
    state="$(lockdown_state)"
    if any_backend_is_scaled_to_zero; then
        some_backend_is_stopped="true"
    fi
    # Clearing a preview, or running 'off' when nothing is on, is not a window and is not announced.
    if [ "$state" = "ON" ] || [ "$some_backend_is_stopped" = "true" ]; then
        a_window_is_active="true"
    fi

    # Every confirmation is asked before anything changes, so an announced shutdown is never silently abandoned.
    echo "Current lockdown state: $state"
    confirm_or_exit "This will REOPEN ${client_host} and ${api_host} to the public."
    if [ "$state" = "ON" ] && ! caller_is_in_bypass_allowlist; then
        api_health_can_be_verified="false"
        confirm_or_exit "This machine is not in the bypass allowlist, so API health cannot be verified before reopening."
    fi

    if [ "$a_window_is_active" = "true" ]; then
        slack_operation_in_flight_description="Turning maintenance mode OFF"
        send_slack_notification ":unlock: *Maintenance mode is being turned OFF on ${environment_short_name}* by $(effective_gcloud_identity).
Backends are resumed and checked first, then ${client_host} and ${api_host} reopen."
    fi

    if [ "$some_backend_is_stopped" = "true" ]; then
        echo "Some backends are still stopped; resuming them first."
        resume_backends
    fi

    # Reopening onto an unhealthy API would trade the maintenance page for raw errors, so verify first when possible.
    if [ "$state" = "ON" ] && [ "$api_health_can_be_verified" = "true" ]; then
        echo "Verifying API health through the bypass before reopening..."
        wait_until_api_is_healthy ||
            die "the API is not healthy. Lockdown was left ON. Fix the backends, then run 'off' again."
    fi

    echo "Turning lockdown off..."
    set_lockdown_rule "allow" "--no-preview" "OFF $(change_stamp)"
    set_bypass_cidrs "$BYPASS_PLACEHOLDER_CIDR" "Maintenance bypass allowlist (empty)"

    echo "Waiting for both hosts to reopen..."
    wait_until_both_hosts_are "open" ||
        die "both hosts did not report open within ${PROPAGATION_TIMEOUT_SECONDS}s. The rule IS set to allow; check '$0 $environment_short_name status' and the Cloud Run services."

    if [ "$a_window_is_active" = "true" ]; then
        send_slack_notification ":white_check_mark: *Maintenance mode is OFF on ${environment_short_name}.* ${client_host} and ${api_host} are verified open again."
    fi
    slack_operation_in_flight_description=""

    cat <<POST_WINDOW

Maintenance mode is OFF. Post-window checks:
  - Re-enable the AUTO_PUSH_PROD schedule and any deploy hold.
  - Interrupted jobs re-run on their own. Check the dev-tools Jobs page for anything left failed.
  - Stripe and Shopify retry the webhooks they could not deliver. Ask Whalesync to replay subscription changes made
    during the window (their client retries a 5xx only once).
  - Re-enable the scratch-git background GC loop if you turned it off, and remove any alert snoozes.
  - Update status.scratch.md, and confirm 'terraform plan' is clean for this environment.
POST_WINDOW
}

case "$command_name" in
    status) command_status ;;
    on) command_on ;;
    resume-backends) command_resume_backends ;;
    off) command_off ;;
    *)
        echo "Unknown command: $command_name" >&2
        usage
        exit 1
        ;;
esac
