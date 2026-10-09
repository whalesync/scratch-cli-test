#!/bin/bash
# Shared by Scratch's scripts that reach a GCP Cloud SQL database through an SSH tunnel to
# the cloudsql-proxy VM: terraform/tools/connect_to_gcp_db.sh,
# terraform/tools/connect_to_gcp_db_readonly.sh, terraform/tools/get_gcp_database_url.sh and
# server/tools/run_database_migrations.sh. Source it; don't run it.
#
# Scratch's tunnels listen on 127.0.0.1, on the first free local port from 5533 to 5552.
# Whalesync's tunnel scripts take 5433-5452 (and its local side databases 5442/5443), so the
# two products' tunnels never share a port. They used to: both forwarded 5433, and Scratch's
# scripts only checked that *something* was listening there, so a Scratch script run while a
# Whalesync tunnel was open sent Scratch's credentials to Whalesync's production database
# (DEV-11794).
#
# Each run opens its own tunnel and goes on only once its own ssh holds the port, so
# overlapping runs (e.g. an agent running read-only queries in parallel) never connect through
# another run's tunnel, which may be for a different environment and closes when that run exits.

FIRST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT=5533
LAST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT=5552

LOCAL_HOSTNAME="127.0.0.1"
LOCAL_PORT=$FIRST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT

# The background `gcloud compute ssh` holding this run's tunnel. Empty until
# open_gcp_db_tunnel starts one; callers kill it in their EXIT trap.
ssh_tunnel_to_proxy_pid=""

# True once LOCAL_PORT is held by this run's own ssh, which gcloud starts as a child.
function local_port_is_held_by_this_runs_tunnel {
  local listener_pid ancestor_pid
  for listener_pid in $(lsof -nP -t -iTCP:"$LOCAL_PORT" -s tcp:listen); do
    ancestor_pid=$listener_pid
    for _ in 1 2 3; do
      ancestor_pid=$(ps -o ppid= -p "$ancestor_pid" | tr -d ' ')
      if [ -z "$ancestor_pid" ]; then
        break
      fi
      if [ "$ancestor_pid" = "$ssh_tunnel_to_proxy_pid" ]; then
        return 0
      fi
    done
  done
  return 1
}

# Forwards 127.0.0.1:LOCAL_PORT through the cloudsql-proxy VM to <database_host>:5432, on the
# first free port in Scratch's range. Sets LOCAL_PORT and ssh_tunnel_to_proxy_pid, and exits
# the script if no tunnel comes up, so don't call it in a subshell.
#
# arg1: GCP project, e.g. spv1eu-production
# arg2: zone of the cloudsql-proxy VM, e.g. europe-west1-b
# arg3: private IP of the Cloud SQL instance
function open_gcp_db_tunnel {
  local gcp_project=$1
  local cloudsql_proxy_zone=$2
  local database_host=$3
  local remote_port=5432
  local tunnel_attempt=0
  local max_tunnel_attempts=5
  local seconds_between_port_checks=5
  local max_seconds_to_wait_for_tunnel=600
  local seconds_waited_for_tunnel

  LOCAL_PORT=$FIRST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT
  while true; do
    while lsof -nP -iTCP:"$LOCAL_PORT" -s tcp:listen >/dev/null; do
      LOCAL_PORT=$((LOCAL_PORT + 1))
      if [ "$LOCAL_PORT" -gt "$LAST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT" ]; then
        echo "No free local port between $FIRST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT and $LAST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT. Close some open tunnels and try again."
        exit 1
      fi
    done

    # Bind 127.0.0.1 only, the address every caller connects to. With ssh's default bind of
    # both 127.0.0.1 and ::1, ssh counts the forward as set up if either one binds, so a
    # foreign listener on 127.0.0.1 that lsof can't see would still get our connections.
    # ExitOnForwardFailure makes ssh exit, rather than carry on without a tunnel, if the bind
    # fails because another process took the port first.
    echo "Starting SSH tunnel to the cloudsql-proxy VM in $gcp_project on local port $LOCAL_PORT: $database_host"
    gcloud compute ssh cloudsql-proxy --project "$gcp_project" --zone "$cloudsql_proxy_zone" --tunnel-through-iap -- \
      -N -o ExitOnForwardFailure=yes -L "$LOCAL_HOSTNAME:$LOCAL_PORT:$database_host:$remote_port" &
    ssh_tunnel_to_proxy_pid=$!

    seconds_waited_for_tunnel=0
    while ! local_port_is_held_by_this_runs_tunnel && kill -0 "$ssh_tunnel_to_proxy_pid" 2>/dev/null; do
      echo "Waiting for port $LOCAL_PORT to be open..."
      sleep "$seconds_between_port_checks"
      seconds_waited_for_tunnel=$((seconds_waited_for_tunnel + seconds_between_port_checks))
      if [ "$seconds_waited_for_tunnel" -ge "$max_seconds_to_wait_for_tunnel" ]; then
        echo "Timeout after $max_seconds_to_wait_for_tunnel seconds. Port $LOCAL_PORT is still not open."
        echo "Failed to set up SSH tunnel to GCP VM!"
        exit 1
      fi
    done

    if local_port_is_held_by_this_runs_tunnel; then
      return 0
    fi

    tunnel_attempt=$((tunnel_attempt + 1))
    if [ "$tunnel_attempt" -ge "$max_tunnel_attempts" ]; then
      echo "Failed to set up SSH tunnel to GCP VM!"
      exit 1
    fi
    # Another run may have taken the port, or something lsof can't see holds it.
    echo "SSH tunnel on port $LOCAL_PORT exited. Retrying on the next port."
    LOCAL_PORT=$((LOCAL_PORT + 1))
    if [ "$LOCAL_PORT" -gt "$LAST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT" ]; then
      echo "No free local port between $FIRST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT and $LAST_SCRATCH_GCP_DB_TUNNEL_LOCAL_PORT. Close some open tunnels and try again."
      exit 1
    fi
  done
}
