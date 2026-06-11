# Running connector-build sessions in parallel

A plan for running **N agents in parallel**, each building/testing a different connector on its own branch, while **sharing the expensive, branch-independent pieces** (one `scratch-git-2`, one CLI binary, one Postgres, one gstack browser). Companion to the [`/connector-build`](/.claude/skills/connector-build/SKILL.md) skill and its [playbook](connector-build.md).

> **Status:** plan / proposal. The "shared infra, per-port servers" topology works **today** with one ops gotcha (worker/queue isolation) and one optional small code change. See [Open items](#open-items).

---

## TL;DR — recommended topology

```
                ┌──────────────────────────────────────────────┐
  SHARED  ──►   │  Postgres (one DB)   ·   scratch-git-2 (:3100/:3101, one repos dir)  │
  (run once)    │  gstack browse daemon (one, shared tabs)   ·   scratchmd CLI binary  │
                └──────────────────────────────────────────────┘
                        ▲                 ▲                 ▲
   PER SESSION ─────────┼─────────────────┼─────────────────┼─────────
   (one agent each)     │                 │                 │
        session A:  server :3010 (monolith, branch A worktree) + Redis A (own queue)
        session B:  server :3011 (monolith, branch B worktree) + Redis B (own queue)
        session C:  server :3012 (monolith, branch C worktree) + Redis C (own queue)

   each agent's shell:  export SCRATCH_URL=http://localhost:<that session's port>
   so every `scratchmd …` call hits that session's server with no per-call flag.
```

The only thing that **must** be per-session is: **the server build (branch code) + its worker + an isolated job queue.** Everything else is shared.

---

## What's shared vs per-session (the whole idea)

| Piece | Shared or per-session? | Why |
|---|---|---|
| **scratch-git-2** (`:3100` API, `:3101` git backend) | **Shared, run once** | Branch-independent Rust service; repos keyed by **workbook id** on disk under `GIT_REPOS_DIR`, protected by per-repo write locks. Different workbooks never collide. Confirmed: `scratch-git-2/src/service/config.rs` (ports + `GIT_REPOS_DIR`), `service/mod.rs` (write-lock manager). |
| **scratchmd CLI** binary | **Shared, build once from `main`** | Thin REST client; embeds no connector code. Targets a server per call via `--scratch-url`/`SCRATCH_URL`. |
| **Postgres** | **Shared** (recommended) | Holds workbooks, connector accounts, jobs, API tokens. Connector code is **not** in the DB. One login works across all servers (see [Auth](#auth-one-login-for-all-local-servers)). |
| **gstack browser** | **Shared, one daemon** | Rarely needed (CLI-first). One tab per session; see [Browser](#sharing-the-gstack-browser). |
| **Server process** | **Per session** (branch worktree, distinct `PORT`) | The server **imports connector code at compile time** (`server/src/remote-service/connectors/library/<connector>/`), so each branch needs its own build. |
| **Worker + job queue** | **Per session** (run the server as a **monolith**, isolated Redis) | Pulls/publishes run in the worker, which executes **this build's** connector code. See the constraint below. |

---

## The one real constraint: worker code identity

`scratchmd linked pull` and `files publish` don't run synchronously in the API — they enqueue **BullMQ jobs** that the **worker** processes. The worker instantiates the connector from the registry **compiled into that server build**. So:

- A job for connector A must be processed by a worker running **branch A's** code.
- The queue name is hardcoded **`'worker-queue'`** in every enqueue/consume site (`worker/bull-worker.service.ts:61,66`, `worker-enqueuer/bull-enqueuer.service.ts:38`, `job/job.service.ts:215,272,309,371`).
- The Redis connection is built from **only** `getRedisHost()`/`getRedisPort()`/`getRedisPassword()` — **no DB index, no key prefix** (`config/scratch-config.service.ts:123-131`; constructed in `redis/redis-pubsub.service.ts`, `worker-enqueuer/bull-enqueuer.service.ts`, `worker/bull-worker.service.ts`, etc.).

**Therefore:** if two monolith servers share one Redis, they share one `worker-queue`, and a job enqueued by session A can be dequeued by session B's worker → it runs **B's** connector code against **A's** workbook. Silent wrong-branch testing. Two `npm run dev` (monolith) on one Redis also means **every job runs twice**.

**Fix:** give each session its **own queue**, i.e. its **own Redis** (Option A) or its **own Redis logical DB** (Option B). Run each session as a **monolith** (`yarn dev` default = `SERVICE_TYPE=monolith` = API + worker + cron) so it has a worker with its own branch code.

---

## Isolation options for the queue (pick one)

### Option A — one Redis per session *(zero code change, recommended to start)*
Run a Redis per session on its own port; point each server at it. Shared Postgres + scratch-git.

```bash
# extra Redis instances (docker), one per session beyond the default 6379
docker run -d --name redis-b -p 6380:6379 redis:7
docker run -d --name redis-c -p 6381:6379 redis:7
```
- Session A → `REDIS_PORT=6379`, B → `6380`, C → `6381`.
- Fully isolates the queue **and** the realtime pub/sub (both run on that session's Redis).
- Cost: one cheap container per session.

### Option B — one Redis, a logical DB per session *(small code change, the proper fix)*
ioredis/BullMQ accept a `db` index (0–15). Add `getRedisDb()` (env `REDIS_DB`, default 0) to `ScratchConfigService` and pass `db:` in the ~5 IORedis/`Queue` constructions listed above. Then sessions differ only by `REDIS_DB=0|1|2…` on **one** Redis. Cleanest long-term; ~10 lines. (Optionally also make the queue name configurable via `WORKER_QUEUE_NAME` for belt-and-suspenders.)

### Option C — fully separate stacks (own Postgres + own Redis per session)
Maximum isolation, most setup: per-session DB migrations, and the CLI auth-token collision **does** bite (see below). **Not recommended** unless you need DB isolation.

**Recommendation:** start with **A** (no code), land **B** when you want a single Redis.

---

## CLI: point each session's calls at its server

The CLI resolves the server URL in this order (`scratch-git-2/src/cli/main.rs:422-426`): `--scratch-url` flag / `SCRATCH_URL` env → `scratchmd.config.yaml` (`server_url`) → compiled default `http://localhost:3010` (`cli/api/mod.rs`).

**Recommended:** each session's agent shell exports the target once, so no per-call flag is needed:
```bash
export SCRATCH_URL=http://localhost:3011   # session B's port
scratchmd workspaces list                  # hits :3011
scratchmd linked pull <dfd> --mode full    # hits :3011
```
(Per-call alternative: `scratchmd --scratch-url http://localhost:3011 …`. Or drop a `scratchmd.config.yaml` with `server_url:` in each session's working dir.)

## Auth: one login for all local servers

`~/.scratchmd/credentials.yaml` keys the token by **hostname with the port stripped** (`cli/config/credentials.rs:37-47`), so `localhost:3010` and `localhost:3011` both map to the key `localhost`. **With a shared Postgres this is benign and actually convenient:** the API token lives in the shared DB, so a single `scratchmd auth …` login produces one token that **every** local server accepts. Log in once; all sessions are authenticated.

> Only Option C (separate DBs) breaks this — then give servers distinct host aliases (`127.0.0.1`, a `/etc/hosts` name) and log in per host.

---

## Sharing the gstack browser

The browse daemon is a **single persistent process** with multiple tabs (`$B tabs`, `$B newtab`, `$B tab <id>`, `$B tab-each`). Since connector-build is **CLI-first and the browser is used rarely** (seed a record in the service UI; confirm a write landed), light sharing is enough:

- **Lightweight (recommended):** all sessions use the same `$B` binary against the one daemon. Each session opens **its own tab** (`$B newtab <url>` → note the tab id) and switches to it (`$B tab <id>`) right before a short burst of browser work. Caveat: the daemon has a single **active tab** and most commands (`goto`, `snapshot`, `click`) act on it — so two agents driving *simultaneously* race. Keep browser bursts short and switch-then-act.
- **Stronger isolation (if simultaneous browser use grows):** `/pair-agent` — built for multiple agents sharing one browser with **per-agent tabs, scoped tokens, tab isolation, and rate limiting**. Heavier; overkill for rare use.
- Run headed (`$B connect`) so a human can watch; import cookies once (`/setup-browser-cookies`).

---

## Concrete startup

### Once (shared — from the `main` checkout)
```bash
# 1. Postgres + the default Redis
cd server/localdev && docker compose up -d && cd ../..

# 2. scratch-git-2 (shared; one repos dir for all sessions)
cd scratch-git-2 && GIT_REPOS_DIR="$PWD/repos" cargo run        # :3100 + :3101
#    (separate terminal; leave running)

# 3. CLI binaries (release + debug), build once from main
cd scratch-git-2 && cargo build --release --bin scratchmd && cargo build --bin scratchmd

# 4. one login (token valid on every local server via shared Postgres)
scratchmd auth login        # or: scratchmd auth status

# 5. gstack browser (shared)
$B connect                  # headed; $B status → Mode: headed
```

### Per session *i* (branch worktree; port `3010+i`; Option A Redis)
```bash
# worktree with the connector branch under test
git worktree add ../spinner-worktrees/<branch> <branch>
cd ../spinner-worktrees/<branch>/server

# monolith so this session has its OWN worker running THIS branch's connector code,
# on its OWN Redis (own queue). Shares Postgres + scratch-git with everyone.
PORT=$((3010+i)) REDIS_PORT=$((6379+i)) yarn dev     # SERVICE_TYPE defaults to monolith

# in the agent shell that drives this session:
export SCRATCH_URL=http://localhost:$((3010+i))
$B newtab about:blank        # this session's browser tab (note its id)
```
Then run `/connector-build <connector>` as normal. Its pulls/publishes are enqueued to **this** session's Redis and processed by **this** session's worker (branch code). ✅

---

## Per-session checklist (hand to each agent)

- [ ] Worktree on the connector's branch; server built there.
- [ ] `PORT` unique; `REDIS_PORT` (or `REDIS_DB`) unique; `SERVICE_TYPE=monolith`.
- [ ] `export SCRATCH_URL=http://localhost:<port>` in the shell (verify: `scratchmd auth status` hits the right server).
- [ ] Workbook name prefixed with the connector (shared Postgres → `workspaces list` shows everyone's; prefix keeps it scannable).
- [ ] Own browser tab; switch to it before any browser burst.
- [ ] Confirm a pull actually processed (job completes) — proves this session's worker/queue is wired, not a neighbor's.

---

## Risks & gotchas

| Risk | Cause | Mitigation |
|---|---|---|
| **Wrong-branch worker runs your job** | Shared Redis → shared `worker-queue` | Per-session Redis (A) or Redis DB index (B). The core rule of this doc. |
| **Every job runs twice** | Two monoliths on one Redis | Same as above (isolate the queue). |
| **CLI hits the wrong server** | Forgot `SCRATCH_URL` | Export it once per shell; verify with `scratchmd auth status`. |
| **Auth confusion** | `credentials.yaml` strips the port | Non-issue with shared Postgres (one token works everywhere). Only matters for Option C. |
| **Browser commands clobber each other** | Single active tab in one daemon | Switch to your tab right before short bursts; or `/pair-agent` for real isolation. |
| **`workspaces list` shows all sessions' workbooks** | Shared Postgres | Cosmetic; prefix workbook names per connector. |
| **scratch-git repo contention** | Two sessions, same workbook | Don't share a workbook across sessions; per-workbook write locks handle the rest. |

---

## Open items (optional code changes, prioritized)

1. **`REDIS_DB` support** (Option B) — add `getRedisDb()` + pass `db:` in the IORedis/`Queue` constructions, so one Redis serves all sessions by logical DB. ~10 lines; the cleanest enabler.
2. **`WORKER_QUEUE_NAME` env** — make the hardcoded `'worker-queue'` configurable for an extra isolation guarantee on a shared Redis.
3. **Keep the port in the CLI credential key** (`cli/config/credentials.rs`) — only needed if we ever run separate-DB sessions (Option C).
4. **Desktop app `SCRATCH_URL` passthrough** — if you want the desktop app to monitor a *specific* session's server (it currently launches `scratchmd` with the default target); set `SCRATCH_URL` before launching, or add a flag.

---

## Why this matches the skill

The [`/connector-build` skill](/.claude/skills/connector-build/SKILL.md) already says: build the **CLI + desktop from `main`** (branch-independent), run **only the server from the branch worktree**. This plan extends that one step: because the **worker** also runs branch connector code, the per-session server must be a **monolith with an isolated queue** — not just an API process pointed at a shared worker. Everything else (scratch-git, CLI, Postgres, browser) is shared exactly as the skill intends.
