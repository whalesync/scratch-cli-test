#!/usr/bin/env bash
#
# start-parallel-session.sh — bring up ONE isolated parallel connector-build session.
#
# Finds the lowest free session index N (≥1), starts this session's own Redis
# (container on 6379+N) and a monolith server (port 3010+N) running THIS worktree's
# branch code with its own BullMQ queue + worker. Postgres / scratch-git / gstack
# stay shared. Implements Option A of .claude/skills/start-parallel-session/parallel-sessions.md.
#
# Ports: server = 3010+N, redis = 6379+N, redis container = spinner-redis-<N>.
#
# RUN IT IN THE BACKGROUND (Claude Bash tool: run_in_background: true). The script
# `exec`s `yarn dev` as its final step, so the background task BECOMES the server and
# stays alive for the session; Redis runs as a detached container. It prints, early:
#   First available N=<n>
#   Redis at: localhost:<6379+N> (container spinner-redis-<N>)
#   Server at: http://localhost:<3010+N>
#
# Re-runnable: a stale Redis container of the same name is force-removed first.
# Teardown: docker rm -f spinner-redis-<N>   (the server is killed on session close).
#
set -euo pipefail

# --- resolve the worktree root from the script's own location (skill lives at
#     <root>/.claude/skills/start-parallel-session/), so it works from any cwd ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$ROOT"
[ -d server ] || { echo "ERROR: no ./server under $ROOT — run from a git worktree root" >&2; exit 1; }

# --- 1. find the lowest free N where BOTH server and redis ports are free ---
port_free() { ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }
N=""
for n in $(seq 1 16); do
  if port_free $((3010 + n)) && port_free $((6379 + n)); then N=$n; break; fi
done
[ -n "$N" ] || { echo "ERROR: no free session index in N=1..16 (all 3011-3026 / 6380-6395 busy)" >&2; exit 1; }

SERVER_PORT=$((3010 + N))
REDIS_PORT=$((6379 + N))
REDIS_NAME="spinner-redis-${N}"

# --- print the chosen ports up front (visible before the slow server compile) ---
echo "First available N=${N}"
echo "Redis at: localhost:${REDIS_PORT} (container ${REDIS_NAME})"
echo "Server at: http://localhost:${SERVER_PORT}"

# --- 2. prerequisites: server/.env must exist (gitignored; symlink/copy from main) ---
if [ ! -e server/.env ]; then
  echo "ERROR: server/.env is missing in this worktree — symlink or copy it from your main checkout first" >&2
  echo "       e.g.  ln -s /path/to/main/spinner/server/.env server/.env" >&2
  exit 1
fi

# --- 3. install server deps if this fresh worktree has none (server workspace only) ---
[ -d server/node_modules ] || (cd server && yarn install)

# --- 4. this session's Redis (idempotent: drop any stale container, then start) ---
docker rm -f "$REDIS_NAME" >/dev/null 2>&1 || true
docker run -d --rm --name "$REDIS_NAME" -p "${REDIS_PORT}:6379" redis:7 >/dev/null
until docker exec "$REDIS_NAME" redis-cli ping 2>/dev/null | grep -q PONG; do sleep 0.5; done
echo "Redis ${REDIS_NAME} ready (PONG)"

# --- 5. monolith server (API + worker + cron in one process → this branch's code) ---
#     `start:dev` = nest start --watch (NO --debug, so no :9229 inspector-port clash
#     across parallel sessions). exec → this process becomes the server.
echo "Starting server on :${SERVER_PORT} (SERVICE_TYPE=monolith, REDIS_PORT=${REDIS_PORT}) — compiling, ~1 min…"
cd server
exec env PORT="$SERVER_PORT" REDIS_HOST=localhost REDIS_PORT="$REDIS_PORT" SERVICE_TYPE=monolith yarn start:dev
