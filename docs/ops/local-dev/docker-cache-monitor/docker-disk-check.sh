#!/bin/bash
# Alerts when Docker Desktop's internal VM overlay disk hits a threshold.
# Installed as a LaunchAgent — see docs/ops/local-dev/docker-disk-monitor.md.

set -u

THRESHOLD=90
LOG_FILE="$HOME/Library/Logs/docker-disk-check.log"
STATE_FILE="$HOME/Library/Caches/docker-disk-check.last-alert"

mkdir -p "$(dirname "$LOG_FILE")" "$(dirname "$STATE_FILE")"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >>"$LOG_FILE"
}

# PATH for launchd context (Docker Desktop installs docker here).
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

if ! command -v docker >/dev/null 2>&1; then
  log "docker CLI not on PATH, skipping"
  exit 0
fi

if ! docker info >/dev/null 2>&1; then
  log "docker daemon not running, skipping"
  exit 0
fi

USE=$(docker run --rm alpine df -P / 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')

if ! [[ "$USE" =~ ^[0-9]+$ ]]; then
  log "could not parse disk usage (got: '$USE')"
  exit 0
fi

log "Docker VM overlay disk at ${USE}%"

if [ "$USE" -lt "$THRESHOLD" ]; then
  rm -f "$STATE_FILE"
  exit 0
fi

# Suppress repeat notifications within the same 6-hour window.
if [ -f "$STATE_FILE" ]; then
  LAST=$(stat -f %m "$STATE_FILE")
  NOW=$(date +%s)
  if [ $((NOW - LAST)) -lt 21600 ]; then
    log "alert suppressed (last alert $(($((NOW - LAST)) / 60)) min ago)"
    exit 0
  fi
fi

MSG="Docker Desktop VM disk is ${USE}% full. Run: docker system prune -a --volumes"
osascript -e "display notification \"${MSG}\" with title \"Docker disk alert\" sound name \"Basso\"" || true
log "ALERT fired at ${USE}%"
touch "$STATE_FILE"
