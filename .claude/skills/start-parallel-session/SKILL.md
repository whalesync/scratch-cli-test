---
name: start-parallel-session
description: Bring up an isolated Scratch server + Redis for one parallel connector-build session, indexed by N. `/start-parallel-session <N>` (N≥1) starts a monolith server on port 3010+N backed by its own Redis container on 6379+N — its own BullMQ queue + worker running THIS worktree's branch code — while sharing Postgres, scratch-git, and the gstack browser with every other session. Implements Option A of docs/connector-build-parallel.md. Idempotent: re-running cleans up a stale container and restarts. Then run /connector-build against this session, always passing --scratch-url http://localhost:<3010+N>.
user-invocable: true
argument-hint: "<N>  (session index, N≥1)"
---

# start-parallel-session

Stand up **one isolated session** for running `/connector-build` in parallel with others. This is the automated form of the **"Per session i"** startup in [docs/connector-build-parallel.md](/docs/connector-build-parallel.md) — read that doc for the full topology and rationale; this skill executes its **Option A** (one Redis per session, zero code change).

**The whole point:** the server compiles connector code at build time and runs pulls/publishes in a **worker** off a BullMQ queue. Two monolith servers on one Redis share `'worker-queue'`, so a job you enqueue can be run by a neighbor's worker against the wrong branch's code — silently. So each session gets its **own Redis** (own queue) and runs as a **monolith** (own worker, this branch's code). Everything else is shared.

```
SHARED (run once, from the main checkout):  Postgres · scratch-git-2 (:3100/:3101) · gstack browser · scratchmd binary
THIS session N:                             server :3010+N (monolith, THIS worktree) + Redis :6379+N (own queue)
```

## Inputs

- `$1 = N`, the **session index**. Must be an **integer ≥ 1**. (N=0 is the default dev stack on 3010/6379 — refuse it.)
- Derived: `server_port = 3010 + N`, `redis_host_port = 6379 + N`, `redis_container_name = spinner-redis-<N>`.

This skill runs the server **from the current working directory's `server/`** — i.e. you are expected to already be inside the git worktree checked out to the connector branch you want to test. The skill does **not** create the worktree (use `git worktree add …` or Conductor first).

## Steps

### 1. Validate and compute ports
- Reject N if it is not an integer ≥ 1. Reject N=0 explicitly (collides with the shared default stack).
- Compute `server_port=$((3010+N))` and `redis_host_port=$((6379+N))`.
- Check both ports are free before doing anything:
  ```bash
  lsof -nP -iTCP:$server_port -sTCP:LISTEN; lsof -nP -iTCP:$redis_host_port -sTCP:LISTEN
  ```
  If either is occupied by a non-`spinner-redis-<N>` / non-this-session process, stop and report — don't stomp a neighbor.

### 2. Confirm the shared stack is up (do NOT start per-session copies of these)
- Postgres + the default Redis: `docker compose -f server/localdev/docker-compose.yml ps` (from the main checkout). If down: `cd server/localdev && docker compose up -d`.
- scratch-git-2 on :3100: `curl -fsS http://localhost:3100/health || curl -fsS http://localhost:3100/` — if down, start it once from the **main** checkout: `cd scratch-git-2 && GIT_REPOS_DIR="$PWD/repos" cargo run` (background; leave running). All sessions share this one repos dir; per-workbook write locks keep them from colliding.
- One login is enough for every local server (token lives in shared Postgres): `scratchmd auth status` — if not logged in, `scratchmd auth login` once.

### 3. Ensure this worktree has a `server/.env`
`server/.env` is **gitignored** and the server loads it from the cwd ([scratch-config.module.ts:9](/server/src/config/scratch-config.module.ts#L9)); a fresh worktree has none and the server will throw on missing required vars (`SERVICE_TYPE`, `ENCRYPTION_MASTER_KEY`, `STRIPE_API_KEY`, …).
- If `server/.env` is missing in the current worktree, **symlink it from the main checkout** so secrets stay in one place:
  ```bash
  # adjust the path to wherever your main (non-worktree) checkout lives
  ln -s /Users/ijd/repos/spinner/server/.env server/.env
  ```
  (Copy instead of symlink if you need this session to diverge.) The inline `PORT`/`REDIS_PORT` in step 5 **override** the file's values — dotenv does not clobber pre-set process env — so the shared `.env` + inline overrides is correct.

### 4. Start this session's Redis (idempotent; best-effort die-on-close)
Containers are owned by `dockerd`, not by this agent, so "dies exactly when the agent closes" is **not guaranteed**. We get die-on-*graceful*-close by running a foreground `--rm` container inside a **background Bash** (session teardown SIGTERMs it → it stops and self-removes), and we make restart bulletproof by force-removing any stale container of the same name first:
```bash
docker rm -f spinner-redis-<N> 2>/dev/null || true
```
Then start it in a **background Bash call** (`run_in_background: true`) — foreground container (NOT `-d`) so its lifetime tracks the background process:
```bash
docker run --rm --name spinner-redis-<N> -p $((6379+N)):6379 redis:7
```
Wait until it answers: `docker exec spinner-redis-<N> redis-cli ping` returns `PONG`.

> A `kill -9` of the whole session can still leak the container; step 1's port check + this `docker rm -f` make the next start clean. To tear down by hand: `docker rm -f spinner-redis-<N>`.

### 5. Start this session's monolith server (background)
From `server/` in this worktree, in a **background Bash call**:
```bash
cd server && PORT=$((3010+N)) REDIS_HOST=localhost REDIS_PORT=$((6379+N)) SERVICE_TYPE=monolith yarn dev
```
- `SERVICE_TYPE=monolith` ⇒ API + **worker** + cron in one process, so this session's pulls/publishes run on **this branch's** connector code.
- `REDIS_PORT` points the queue **and** realtime pub/sub at this session's Redis — full queue isolation.

### 6. Wait for readiness
Poll the health endpoint until green (server compiles on first `yarn dev`, so allow a minute+):
```bash
until curl -fsS http://localhost:$((3010+N))/health >/dev/null 2>&1; do sleep 3; done
```

### 7. Point scratchmd at THIS server — on every call
Bash-tool shells **do not persist env between calls**, so `export SCRATCH_URL` will not carry over. Two robust choices (pick one, tell the user which):
- **Per-call flag (explicit, always works):** pass `--scratch-url http://localhost:$((3010+N))` on **every** `scratchmd` invocation.
- **Per-cwd config (recommended, zero per-call typing):** write `scratchmd.config.yaml` in the working dir you'll run `scratchmd` from — the CLI reads it from `current_dir()` each call ([project_config.rs:21-24](/scratch-git-2/src/cli/config/project_config.rs#L21-L24)). Exact shape (note the key is `scratchServerUrl`, under `settings:`):
  ```yaml
  settings:
    scratchServerUrl: http://localhost:<3010+N>
  ```

### 8. Prove the isolation is real (don't skip)
A green health check only proves the API is up — not that **this** session's worker handled your job. Run one real job end-to-end and confirm it **completes**:
```bash
scratchmd --scratch-url http://localhost:$((3010+N)) auth status        # hits the right server
scratchmd --scratch-url http://localhost:$((3010+N)) workspaces list     # shared DB → you'll see everyone's; prefix your workbook with the connector name
# after wiring a workbook, run a real pull and watch it reach "completed"
scratchmd --scratch-url http://localhost:$((3010+N)) linked pull <dfd> --mode full
```
If the pull completes, this session's worker + queue are correctly wired to its own Redis and branch code. ✅

### 9. Hand off
Report to the user: the server URL (`http://localhost:<3010+N>`), the Redis container name/port, that both run in background and stop on graceful session close, and the one-line teardown. Then run `/connector-build <connector>` as normal, always carrying the `--scratch-url` (or the config file).

## Teardown
```bash
docker rm -f spinner-redis-<N>          # stop + remove this session's Redis
# the background `yarn dev` is killed by the harness on session end; or find+kill its PID
```

## Caveats
- **Shared Postgres ⇒ shared schema.** If this branch has DB **migrations** not present in other running sessions, a shared DB is unsafe (schema drift / running another branch's migration). Connector work rarely adds migrations; if yours does, use a fully separate stack (doc's Option C) instead. Check with `git diff --stat <main>...HEAD -- server/prisma` before starting.
- **`workspaces list` shows every session's workbooks** (shared DB) — cosmetic; prefix your workbook name with the connector so it's scannable.
- **Never share one workbook across two sessions** — per-workbook write locks in scratch-git protect concurrent access, but two agents editing the same workbook is asking for confusion.
- **Browser:** the gstack daemon has a single active tab; open your own tab and switch to it right before short bursts. See the doc's "Sharing the gstack browser".

## Reference
- [docs/connector-build-parallel.md](/docs/connector-build-parallel.md) — full topology, the worker-code-identity constraint, isolation Options A/B/C, risks table.
- [.claude/skills/connector-build/SKILL.md](/.claude/skills/connector-build/SKILL.md) — what you run inside the session.
