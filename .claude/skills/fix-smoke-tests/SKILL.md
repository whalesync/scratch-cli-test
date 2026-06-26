---
name: fix-smoke-tests
description: Investigate and diagnose a failed "smoke tests" GitLab job — the end-to-end pull/publish/sync smoke suite that runs inside a Docker Compose stack on the scheduled pipeline. Accepts either a failed job URL or a pipeline URL (resolving the failed "smoke tests" job within it). Pulls the job trace, determines which LAYER failed (scratch-git-2 Rust build, docker image build, service bring-up/health, or the Jest smoke specs in the test-runner container), correlates against recent master commits, decides whether each failure is a test/harness bug, a real system bug, or a stack/infra failure, and presents a fix plan. Use when the user reports a failed "smoke tests" job or pastes a GitLab job or pipeline URL for one.
user-invocable: true
argument-hint: "[gitlab-job-or-pipeline-url]"
allowed-tools:
  - Bash(glab api:*)
  - Bash(glab ci trace:*)
  - Bash(glab auth status:*)
  - Bash(git log:*)
  - Bash(git rev-parse:*)
  - Bash(git fetch:*)
  - Bash(git branch:*)
  - Bash(git worktree:*)
  - Bash(git checkout:*)
  - Bash(git switch:*)
  - Read
  - Grep
  - Glob
  - Edit
  - Write
---

# Fix Failed Smoke Tests

Investigate a failed **smoke tests** GitLab job, determine **which layer of the
job failed**, pinpoint the cause (a failing spec in [`smoke-tests/`](/smoke-tests/),
a broken build, or an unhealthy service), find likely culprits in recent
`master` history, decide whether each failure is a test/harness problem, a real
system bug, or a stack/infra failure, and present a fix plan.

The smoke tests are the project's **end-to-end** suite: Jest specs under
[`smoke-tests/`](/smoke-tests/) (`@spinner/smoke-tests`, run via `test:smoke`,
`maxWorkers: 1`, 120s/test) that drive the **real NestJS server** through the
full pull → publish → sync round-trip, against **fake connector APIs**
(fake-airtable, fake-memberstack, fake-hubspot, fake-affinity) and a fake GCS,
with [`scratch-git-2`](/scratch-git-2/) as the git storage layer, all wired
together in one Docker Compose network. Auth is a Clerk JWT for the test user.
The ~13 specs live under `pull/`, `publish/`, and `sync/`.

This job is **structurally different** from the unit/integration jobs — it is not
just "run Jest." It builds a Rust binary, builds several Docker images, brings up
a multi-service stack, and only then runs the specs inside a `test-runner`
container. A failure can therefore live in any of four layers, and **most of the
diagnostic value is figuring out which one** (step 3) before looking at
individual tests. The CLI and server integration suites have their own skills
([`fix-cli-integration-tests`](/.claude/skills/fix-cli-integration-tests/SKILL.md),
[`fix-server-integration-tests`](/.claude/skills/fix-server-integration-tests/SKILL.md)).

## How the job runs (read this before parsing a trace)

Defined in
[`gitlab-ci/stages/01-smoke-tests.yml`](/gitlab-ci/stages/01-smoke-tests.yml):
the `smoke tests` job extends `.smoke-tests`, stage `build and test`, **timeout
60m**.

| Phase | What happens | What a failure here looks like |
| --- | --- | --- |
| `before_script` | Installs Rust if missing, then `cargo build --release --bin scratch-git-2` (the Dockerfile COPYs the prebuilt binary). | Rust compile error; **job dies before any container starts**. |
| `script` (build) | Writes `smoke-tests/.env.integration` (Clerk creds), then `docker compose -f smoke-tests/docker-compose.smoke-test.yml --profile ci up --build -d`. Builds every image one at a time (`COMPOSE_PARALLEL_LIMIT=1`). | Image build failure (`failed to solve`, `yarn install` error). |
| `script` (run) | The stack starts detached; `migrate` runs `prisma migrate deploy`; `server` + fakes must become healthy; the `test-runner` container (`profile: ci`) runs the Jest specs. Job streams `docker compose logs -f test-runner`, then `docker compose wait test-runner`. | Service never healthy, `migrate` fails, or Jest specs fail. **The test-runner's exit code is the job's pass/fail.** |
| `after_script` | `docker compose ... down -v` (always). | — |

**When it runs:** only on the **scheduled pipeline** with
`CI_PIPELINE_SOURCE == "schedule"` and `PIPELINE_NAME == "Scheduled Tests"`, and
it is skipped for local-runner users. It does **NOT** run on MRs or on
merge-to-master. So the failing commit is whatever was on `master` when the
schedule fired — see step 5.

**Stack services** (from
[`smoke-tests/docker-compose.smoke-test.yml`](/smoke-tests/docker-compose.smoke-test.yml)):
`db`, `redis`, `scratch-git-2`, `fake-airtable`, `fake-memberstack`,
`fake-hubspot`, `fake-affinity`, `fake-gcs`, `fake-gcs-bucket-init` (one-shot),
`migrate` (one-shot), `server`, and `test-runner` (CI-only, `profile: ci`). The
`server` `depends_on` every fake + `migrate` + `fake-gcs-bucket-init`; the
`test-runner` `depends_on: server` being healthy.

## Inputs

- **gitlab-url** (argument, optional): either
  - a **job URL**, e.g. `https://gitlab.com/whalesync/spinner/-/jobs/15036936606`, or
  - a **pipeline URL**, e.g. `https://gitlab.com/whalesync/spinner/-/pipelines/2631963351`,
    which contains the failed `smoke tests` job.

If no URL was provided as an argument, **ask the user for the GitLab job or
pipeline URL** before doing anything else. Do not guess an ID.

## Steps

### 1. Parse the URL, resolve the job ID, and check auth

The project is `whalesync/spinner` (URL-encoded `whalesync%2Fspinner`).

- Run `glab auth status` first. If it reports `401 Unauthorized`, `No token
  found`, or otherwise fails, stop and tell the user to run `glab auth login`
  (or `glab auth login --token <gitlab-PAT>`) themselves, then ask you to retry.
  Do not continue until auth succeeds.

- **If it's a job URL** (`/-/jobs/<JOB_ID>`): extract the trailing numeric
  **job ID** directly.

- **If it's a pipeline URL** (`/-/pipelines/<PIPELINE_ID>`): extract the pipeline
  ID, then list its jobs and find the failed smoke job:

  ```
  glab api "projects/whalesync%2Fspinner/pipelines/<PIPELINE_ID>/jobs?per_page=100"
  ```

  From the JSON, pick the failed job whose `name` is exactly `smoke tests`. Use
  its `id` as the job ID. Notes:
  - Prefer a job with `status` of `failed`. If it is `success`, tell the user the
    smoke tests passed in that pipeline and confirm they have the right pipeline.
  - **Ignore the `notify slack on smoke test failure` job** — it's a notifier,
    not the test run.
  - If there is **no `smoke tests` job in the pipeline**, the smoke tests didn't
    run there. They run **only on the scheduled "Scheduled Tests" pipeline**, not
    on MRs or merge-to-master. Tell the user this and ask for the scheduled
    pipeline's URL (or the smoke job URL directly).

### 2. Pull the failed job's log

Fetch the full job trace via the API (works for completed jobs; `glab ci trace`
is geared toward live jobs). The trace is large and noisy (it includes Rust
build output, Docker build output for every image, and the streamed test-runner
logs) — save it to the scratchpad and work from the file rather than dumping it
into context:

```
glab api projects/whalesync%2Fspinner/jobs/<JOB_ID>/trace > <scratchpad>/job-<JOB_ID>.log
```

If the API call fails:
- A `404` usually means a bad job ID or wrong project slug — re-check the URL
  with the user.
- Otherwise, fall back to `glab ci trace <JOB_ID>` and report what you see.

Confirm the log is actually a smoke run (look for `docker compose`, `up --build`,
`--profile ci`, or `test-runner`). If it's a different job type (e.g. unit tests,
the CLI or server integration tests — which have their own skills), tell the user
and ask for the correct URL.

### 3. Determine WHICH LAYER failed (the core of this skill)

**Do this before hunting for individual test failures.** The trace is layered,
and a failure in an early layer means **no specs ran at all** — so per-test
verdicts would be fiction. Grep the trace for layer markers, working in order,
and stop at the first layer that failed:

1. **Rust build** (`before_script`) — search for `cargo build --release` and,
   after it, `error[E` / `error: could not compile` / `error: cannot find`. A
   failure here means scratch-git-2 didn't compile; the job died before any
   container started. This is almost always a real bug in a recent
   `scratch-git-2/` change.

2. **Docker image build** (`up --build`) — search for `failed to solve`,
   `ERROR [`, `npm ERR!` / `error Command failed` / `yarn install`, or
   registry/network timeouts. Builds run one at a time
   (`COMPOSE_PARALLEL_LIMIT=1`), so the failing `[<service> …]` stage names the
   image. The stack never came up.

3. **Service bring-up / health** — search for `dependency failed to start`,
   `exited (`, `is unhealthy`, `service "migrate"`, `prisma migrate`,
   `migrate deploy`, or a service that never reports healthy. The `server`
   depends on `migrate` + every fake; the `test-runner` depends on `server`. If
   `migrate` fails or `server` never becomes healthy, **the test-runner never
   runs** and you'll see a compose dependency error rather than Jest output.

4. **Jest specs** (`test-runner` container) — the job streams
   `docker compose logs -f test-runner`, so the Jest output appears in the trace
   **prefixed with the container name**, e.g. `test-runner-1  | ` (or
   `smoke-tests-test-runner-1  | `). Grep that prefix to isolate the Jest run
   from the build/compose noise, then look for `FAIL <file>`, the `●` test paths,
   `expect(received)` diffs / thrown errors, and the tail summary
   (`Tests: X failed, Y passed`). This is the layer where you do per-spec triage
   (steps 4–6).

> **Honesty note — the trace does not contain service logs.** The stack starts
> detached (`up -d`) and the job streams **only** the `test-runner` logs. The
> runtime logs of `server`, `scratch-git-2`, `migrate`, and the fakes are **not
> in the trace**. A service that crashed at runtime shows up only indirectly —
> as test-runner connection errors / timeouts, or as a compose
> `dependency failed to start`. To get the crashing service's own stack trace you
> must reproduce locally and run `docker compose ... logs <service>` (step 4).
> Say this plainly rather than inventing a root cause from the test-runner's
> symptoms.

### 4. Summarize the failure BEFORE deep investigation

Present a concise summary and pause here — this is the checkpoint before the deep
dive. Lead with the **failure layer** from step 3, then:

- **If it failed at the Rust build, image build, or bring-up layer:** say so
  clearly, name the failing component (the crate/file, the image stage, or the
  service), and state that **the smoke specs never ran** — there are no per-test
  verdicts to give. Skip the Jest table.
- **If the test-runner ran:** give a short table — failing spec file, failing
  test path (`describe › it`), one-line failure reason, and a first-glance
  category (assertion / connector-flow error / timeout / setup). Add the totals
  from the Jest summary line (N suites, M tests).

Then give **copy-pasteable instructions to reproduce locally**. The smoke stack
needs Docker and a `CLERK_SECRET_KEY` in `smoke-tests/.env.integration` (copy
from `smoke-tests/.env.integration.example`):

```bash
# From the repo root
nvm use                                                              # Node 22
cp smoke-tests/.env.integration.example smoke-tests/.env.integration  # then set CLERK_SECRET_KEY

smoke-tests/run.sh                          # whole suite: docker stack + jest on the host
smoke-tests/run.sh pull/pull-basic.spec.ts  # a single spec

# Inspect a service the CI trace does NOT contain the logs for:
docker compose -f smoke-tests/docker-compose.smoke-test.yml logs server
docker compose -f smoke-tests/docker-compose.smoke-test.yml logs migrate
docker compose -f smoke-tests/docker-compose.smoke-test.yml logs scratch-git-2

# Tear down:
docker compose -f smoke-tests/docker-compose.smoke-test.yml down -v
```

`run.sh` runs the host-side variant (services in Docker, Jest on the host). To
mirror CI exactly — the `test-runner` inside the Docker network — use
`docker compose --env-file smoke-tests/.env.integration -f smoke-tests/docker-compose.smoke-test.yml --profile ci up --build`.

### 5. Scan recent master commits for likely causes

Smoke tests run on the **scheduled** pipeline, so the break is whatever landed on
`master` since the last *green* scheduled smoke run — which may be wider than a
day. Start with the recent window and widen if nothing fits:

```
git fetch origin master
git log --since="48 hours ago" origin/master --oneline --stat
```

For richer context on a suspicious commit, use
`git log --since="48 hours ago" origin/master -p -- <path>`. To bound the
last-good commit, you can also look at the **previous "Scheduled Tests"
pipeline's** `smoke tests` job (was it green?) via
`glab api "projects/whalesync%2Fspinner/pipelines?per_page=20"` and widen the
`--since` to cover everything merged since the last passing run.

Focus the correlation on the paths that drive this job:

- [`scratch-git-2/`](/scratch-git-2/) — the Rust git service: a compile error
  breaks the `before_script` build; a behavior change can break the E2E
  round-trip.
- [`server/src/remote-service/`](/server/src/remote-service/) — the
  pull/publish/sync pipeline and the **faked connectors** the specs exercise
  (Airtable, Memberstack, HubSpot, Affinity).
- `server/prisma/` migrations — a bad migration fails the `migrate` one-shot and
  the `server` never boots.
- [`smoke-tests/`](/smoke-tests/) — the specs, the helpers (`test-api-client.ts`,
  `wait-for-job.ts`, `test-fixtures.ts`), `connector-fixtures/`, the
  `docker-compose.smoke-test.yml`, the `Dockerfile*`, and `run.sh`.
- `test-api-fakes/` — the fake connector APIs the stack builds and the specs
  seed/assert against.
- [`packages/shared-types/`](/packages/shared-types/) — shared contracts the
  server and the specs both consume.
- [`gitlab-ci/stages/01-smoke-tests.yml`](/gitlab-ci/stages/01-smoke-tests.yml) —
  the job/compose invocation, env wiring, Clerk vars.

Map the failing layer/specs to the commits that touched their code path and call
out the most likely culprits with commit hashes and subjects.

### 6. Decide: test/harness bug, real system bug, or stack/infra failure

For each failure, reach a reasoned verdict — read the actual spec source and the
implicated product code (use the stack-trace frame), don't guess from the name:

- **Real system bug** — an E2E spec asserts correct pull/publish/sync behavior
  and the product code (`server/...`, a connector, or `scratch-git-2`) now does
  the wrong thing: wrong pulled/published/synced output, a broken round-trip,
  malformed schema, data corruption, or an error where success is expected. This
  is the **highest-severity** outcome — smoke tests are full end-to-end, so this
  is the regression they exist to catch. Connector changes must preserve verbatim
  external-data fidelity and dynamic schema discovery (see
  [`CONNECTOR_GUIDE.md`](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md)).
- **Test / harness bug** — the spec, a test helper, or a **fake connector API /
  fixture** encodes an outdated assumption: a changed JSON shape, a renamed
  field, a new required input, a tightened/loosened assertion, a hardcoded value,
  or a timing/polling assumption in `wait-for-job.ts`. The fix lives in
  [`smoke-tests/`](/smoke-tests/) or in `test-api-fakes/`. (This is the smoke
  analogue of the server skill's "live-data drift" — except the "service" is a
  fake we own, so the fix is code, never re-seeding a live account.)
- **Stack-bring-up / build failure** — a Rust compile error, a Docker image
  build failure, a bad migration, or a service that never became healthy
  (layers 1–3 of step 3). The test-runner may never have run a single spec. The
  fix belongs in the source that broke the build, a `Dockerfile`, the
  `docker-compose.smoke-test.yml`, or the CI config — **not** in a per-test
  assertion. Call out plainly that the specs didn't run.
- **Environment / flaky** — a health-check race, a per-test 120s timeout, a DinD
  / network / registry / disk problem, an OOM, an order-dependent flake, or the
  60m job timeout. Not a code bug; note what infra/config needs attention.

Tie the verdict back to the step-5 commit correlation where possible
("`publish-references.spec.ts` fails because `<hash>` changed how the publish
plan resolves foreign keys — real system bug").

### 7. Present the fix plan and set up the working environment

Lay out a concrete plan: for each failure, the verdict, the file(s) to change
(spec/helper/fake vs product code vs Dockerfile/compose/CI), and the specific
change. Order by severity — real system bugs first, then test/harness bugs, then
stack/infra. **Wait for the user to approve the plan before editing anything** —
this skill investigates first and only edits once the user has signed off.

Then handle the working environment. Determine whether you're already on a
dedicated branch/worktree:

- A worktree is in use if `git rev-parse --git-common-dir` differs from
  `git rev-parse --git-dir`.
- Otherwise check the branch: `git rev-parse --abbrev-ref HEAD`. If it's `master`
  (or another protected branch), you are NOT on a safe working branch.

If you are already on a non-`master` branch or in a worktree, say so and proceed
there. **If you are on `master` (and not in a worktree), prompt the user** asking
whether they'd like a dedicated branch and/or worktree created for the fix before
any edits — and let them choose. Suggest a descriptive name such as
`fix-smoke-tests-<YYYY-MM-DD>`. Do not create the branch/worktree or start editing
until the user has answered.

### 8. Implement the approved fixes

Once the plan is approved AND you're on a safe branch/worktree, make the edits:

- Apply each fix from the plan — update spec/helper/fixture or fake-API code for
  test/harness bugs, product code (`server/src/...` or `scratch-git-2/`) for real
  system bugs, or the Dockerfile/compose/CI for stack failures.
- Respect the project's product principles when touching product code: preserve
  verbatim external-data fidelity, keep operations idempotent/resumable, discover
  schemas dynamically, and never silently strip or swallow. See
  [`CLAUDE.md`](/CLAUDE.md) and
  [`CONNECTOR_GUIDE.md`](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md).
- After editing, run `yarn lint` and `yarn build` from the repo root (per the
  project rules) and report results. Do NOT run `prisma migrate` — only
  `prisma generate` if needed.
- Tell the user how to verify locally with `smoke-tests/run.sh` (and the
  single-spec form). **Be honest about what you could and could not verify** —
  the full Docker E2E stack (Clerk secret, several built images, a Rust build)
  usually can't be reproduced from here, so don't claim a green run you didn't
  observe.
- Do not commit or push unless the user asks — leave the changes in the working
  tree for review.

## Important guidelines

- **Find the failure layer first.** The single most useful output is *where* the
  job died — Rust build, image build, service bring-up, or the specs. Everything
  else follows from that. Don't jump to per-test triage before confirming the
  test-runner actually ran.
- **A bring-up failure means the specs never ran.** If `cargo build`, an image
  build, `migrate`, or a service health-check failed, say the smoke specs never
  executed — don't manufacture per-test verdicts from a stack failure.
- **The trace lacks service runtime logs.** Only the `test-runner` logs are
  streamed; `server`/`scratch-git-2`/`migrate`/fakes runtime logs are not in the
  trace. When a service is the suspect, point to local repro + `docker compose
  ... logs <service>` instead of guessing.
- **Read before concluding.** Open the failing spec and the `src/...` /
  `scratch-git-2/...` code before declaring test-bug vs system-bug. A name-based
  guess is not a verdict.
- **Don't edit during the investigation phase.** This skill investigates and
  plans; it stops for plan approval and a safe working environment before editing.
- **A real system bug is the serious finding.** A smoke failure means an
  end-to-end pull/publish/sync round-trip broke — treat a genuine regression as
  higher priority than a stale spec or a drifted fake, and say so plainly.
- **Keep the log out of context.** Save the trace to the scratchpad and grep it
  (the build output alone is thousands of lines); don't paste the whole thing
  into the conversation.
