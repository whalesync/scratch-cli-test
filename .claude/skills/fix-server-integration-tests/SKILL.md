---
name: fix-server-integration-tests
description: Investigate and fix failed server integration tests from a GitLab pipeline. Accepts either a failed job URL or a pipeline URL (resolving the failed server integration job within it — "integration test server", "environment tests for test env post-deploy", or "sync_v1_compat"). Pulls the failed job's log, identifies which server/test/integration suites/tests failed, correlates against recent master commits, decides whether each failure is a test bug or a real system bug, and presents a fix plan. Use when the user reports a failed server integration / environment-tests job or pastes a GitLab job or pipeline URL for one.
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

# Fix Failed Server Integration Tests

Investigate a failed **server integration tests** GitLab job, pinpoint the
failing tests in [`server/test/integration/`](/server/test/integration/), find
likely causes in recent `master` history, decide whether each failure is a test
problem or a real system bug, and present a fix plan.

These are Jest suites under `server/test/integration/` run via
`yarn test:integration` (config
[`server/test/integration/jest-integration.json`](/server/test/integration/jest-integration.json),
`maxWorkers: 1`, `forceExit`). They exercise the NestJS server's connectors,
pull/sync/publish pipeline, and schema generation against a Postgres service
container — and, in the post-deploy variant, against **live external connector
APIs**.

Three CI jobs run this suite (all `yarn run test:integration --verbose
--reporters=default --reporters=jest-junit`, emitting `server/junit.xml`):

| Job name | Stage | When | Connector keys |
| --- | --- | --- | --- |
| `integration test server` | `build and test` | MR touching `server/**` + merge-to-master | none — connector suites self-skip; uses in-process fakes |
| `environment tests for test env post-deploy` | `post-deploy environment tests` | merge-to-master, after deploy | **live** — real API keys from CI/CD vars (Notion, Affinity, Attio, Airtable, Webflow, GoHighLevel, …) |
| `sync_v1_compat` | `build and test` | MR touching `server/**` + merge-to-master | runs ONLY `sync-mapping-v1-compat.spec.ts` |

CI config: [`gitlab-ci/stages/01-build-and-test.yml`](/gitlab-ci/stages/01-build-and-test.yml)
(`integration test server`, `sync_v1_compat`) and
[`gitlab-ci/stages/06-environment-tests.yml`](/gitlab-ci/stages/06-environment-tests.yml)
(`environment tests for test env post-deploy`).

**The job name matters for triage.** Each `*-connector.spec.ts` gates its
`describe` block on its API key (`const describeIfKey = API_KEY ? describe :
describe.skip`), so live-connector suites run ONLY in the post-deploy job and
self-skip everywhere else. A failure there can be a real connector regression OR
a change on the external service's side / live test data drift — distinguish
those in step 6.

## Inputs

- **gitlab-url** (argument, optional): either
  - a **job URL**, e.g. `https://gitlab.com/whalesync/spinner/-/jobs/15036936606`, or
  - a **pipeline URL**, e.g. `https://gitlab.com/whalesync/spinner/-/pipelines/2629246850`,
    which contains the failed server integration job.

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
  ID, then list its jobs and find the failed server integration job:

  ```
  glab api "projects/whalesync%2Fspinner/pipelines/<PIPELINE_ID>/jobs?per_page=100"
  ```

  From the JSON, pick the failed job whose `name` is one of `integration test
  server`, `environment tests for test env post-deploy`, or `sync_v1_compat`.
  Use its `id` as the job ID. Notes:
  - Prefer a job with `status` of `failed`. If more than one of these jobs
    failed, list them and ask the user which to investigate (or take the one
    matching the URL/context).
  - If all of them are `success`, tell the user the server integration tests
    passed in that pipeline and confirm they have the right pipeline.
  - Ignore the `notify slack on environment test failure …` job — it's a
    notifier, not the test run.
  - If none of these jobs exist in the pipeline, tell the user this pipeline
    didn't run the server integration tests (they run on MRs touching
    `server/**` and on merge-to-master) and ask for the correct URL.

Record which of the three jobs you resolved — it determines whether live
connector keys were in play (step 6).

### 2. Pull the failed job's log

Fetch the full job trace via the API (works for completed jobs; `glab ci trace`
is geared toward live jobs). The trace is large — save it to the scratchpad and
work from the file rather than dumping it into context:

```
glab api projects/whalesync%2Fspinner/jobs/<JOB_ID>/trace > <scratchpad>/job-<JOB_ID>.log
```

If the API call fails:
- A `404` usually means a bad job ID or wrong project slug — re-check the URL
  with the user.
- Otherwise, fall back to `glab ci trace <JOB_ID>` and report what you see.

Confirm the log is actually a server integration run (look for
`yarn run test:integration`, `test/integration`, or the Jest summary). If it's a
different job type (e.g. unit tests, build, the CLI integration tests — which
have their own skill `fix-cli-integration-tests`), tell the user and ask for the
correct URL.

### 3. Identify the failed tests

Parse the Jest output. With `--verbose` each suite prints `FAIL
./<suite>.spec.ts` and failing tests are marked `●` with the full `describe ›
it` path, an `expect(received)` diff or a thrown error, and a stack trace
pointing into both the spec and the implicated `src/...` file. The tail has a
summary like `Test Suites: 2 failed, 9 skipped, 21 passed` and `Tests: 5 failed,
117 skipped, 233 passed`. A `Snapshot Summary` line means a snapshot mismatch
(fixable with `yarn run test:integration -u` IF the new output is correct).

For each failure capture:

- The **suite file** (e.g. `notion-connector.spec.ts`).
- The **test path** (`describe › it`).
- The **assertion / error** — expected vs received, thrown error (e.g. a
  `NotionError`/connector API error), timeout, or snapshot diff. Note the
  `src/...` frame in the stack — that's the product code in play.
- Whether it's a **live-connector / external** failure (an API error, auth
  failure, or an assertion against live test-account data) vs a **pure
  in-process** failure (logic/schema/sync assertion with no external call).
- Whether it's an **environment/setup failure** (migrate failed, Postgres
  service down, missing env var, `.env.integration` not read) vs a genuine test
  assertion — triaged differently in step 6.

Cross-reference each failing suite against the real files in
[`server/test/integration/`](/server/test/integration/) so you can describe what
it validates and which connector/pipeline area it covers.

### 4. Summarize failures BEFORE deep investigation

Present a concise summary and pause here — this is the checkpoint before the
deep dive. Include:

- The **resolved job name** and whether it ran with live connector keys.
- A short table: failing suite, failing test path, one-line failure reason, and
  a first-glance category (assertion / connector-API error / snapshot / timeout
  / environment-setup / live-data-drift). Mark environment-setup failures
  clearly — if migrate or the Postgres service failed, the suite may never have
  run.
- Total counts: N suites failed, M individual tests failed (from the Jest
  summary line).

Then give **copy-pasteable instructions to run just the failed tests locally**.
The suite needs a reachable Postgres, applied migrations, and a configured
`server/.env.integration` (copy from `server/.env.integration.example`). For
live-connector suites the relevant API key must be present in
`server/.env.integration` or the suite self-skips — note which keys are needed
for the failing suites:

```bash
# From the repo root
nvm use                        # server tests need the repo's Node (>= 22)
yarn build                     # build shared-types first (CI does .build_shared_types)
cd server
# cp .env.integration.example .env.integration   # if not already configured
yarn run migrate               # apply migrations to the test DB

# Run only the failing suite(s) — the test:integration config takes a path/name filter:
yarn run test:integration notion-connector
# A single test within a suite, by name:
yarn run test:integration notion-connector -t "<exact test name or substring>"
```

List one command per failing suite, substituting the real suite basename
(without `.spec.ts`). `yarn test:integration` with no filter runs everything;
the per-suite filter is faster for iterating. If the failure is a live-connector
test, remind the user it will self-skip without the matching API key set.

### 5. Scan the last 48 hours of master commits for likely causes

Look at recent `master` history in the `spinner` repo for changes that could
have broken the failing suites:

```
git fetch origin master
git log --since="48 hours ago" origin/master --oneline --stat
```

For richer context on suspicious commits, use
`git log --since="48 hours ago" origin/master -p -- <path>` scoped to the
relevant areas. Focus the correlation on paths that drive these tests:

- `server/src/remote-service/connectors/library/<connector>/` — the failing
  connector's pull/publish/schema code (for `*-connector.spec.ts` failures).
- `server/src/remote-service/` and the sync/publish/pull pipeline — for
  `sync-service`, `sync-publish-e2e`, `fetch-edit-publish`, `*-incremental-pull`
  failures.
- `server/test/integration/` — a change to the spec itself (a test edited to a
  wrong expectation, or a fixture/snapshot that drifted).
- `packages/shared-types/` — shared contracts the server and tests both consume.
- `gitlab-ci/` — CI/env changes (new/removed connector key vars, migrate, the
  Postgres service) that could break setup or skip-gating.

Note: the post-deploy `environment tests` job runs **after deploy against the
test environment with live connector keys**, so a failure may reflect a change
that is already deployed, OR a change on the external service / drift in the
live test account's data — not necessarily a commit in this window. Map each
failing suite to the commits that touched its code path and call out the most
likely culprits with commit hashes and subjects.

### 6. Decide: test bug, real system bug, or external/live drift

For each failure, reach a reasoned verdict — read the actual spec source and the
implicated `src/...` code (use the stack-trace frame), don't guess from the name:

- **Test bug** — the spec encodes an outdated assumption (changed schema/JSON
  shape, renamed field, new required input, tightened/loosened assertion,
  ordering, a hardcoded fixture value, a stale snapshot). The server behavior is
  correct; the test (or snapshot) must be updated. A snapshot diff where the new
  output is correct is a test-data update (`-u`), not a bug.
- **Real system bug** — the spec asserts correct behavior and the server now
  does the wrong thing (wrong pull/publish/sync output, broken round-trip,
  malformed schema, data corruption, an error where success is expected). The
  fix belongs in server code. Per the project's principles this is the
  higher-severity outcome — it may mean a pull/sync/publish correctness or
  external-data-fidelity regression. Connector changes especially must preserve
  verbatim API responses and dynamic schema discovery (see
  [`CONNECTOR_GUIDE.md`](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md)).
- **External / live-data drift** (post-deploy job only) — the live external
  service changed its response, rate-limited, returned an auth error, or the
  dedicated test account's anchored fixture data ("[Do Not Touch] …" lists,
  seeded records) was moved/deleted. Not a code bug; the fix is re-seeding test
  data, rotating an expired token, or making the assertion resilient. Confirm
  with the connector's API behavior before calling it drift — don't use it to
  excuse a genuine connector regression.
- **Environment / flaky** — migrate failed, Postgres service unavailable,
  missing env var, network timeout, or an order-dependent flake. Call it out as
  not-a-code-bug and note what infra/config needs attention.

Tie the verdict back to the step-5 commit correlation where possible
("`notion-connector.spec.ts` fails because <hash> changed how `createRecords`
maps properties — real system bug").

### 7. Present the fix plan and set up the working environment

Lay out a concrete plan: for each failure, the verdict, the file(s) to change
(spec/snapshot vs product code vs test-data/infra), and the specific change.
Order by severity — real system bugs first, then test bugs, then external/infra.
**Wait for the user to approve the plan before editing anything** — this skill
investigates first and only edits once the user has signed off.

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
`fix-server-integration-tests-<YYYY-MM-DD>`. Do not create the branch/worktree or
start editing until the user has answered.

### 8. Implement the approved fixes

Once the plan is approved AND you're on a safe branch/worktree, make the edits:

- Apply each fix from the plan — update spec source / snapshots for test bugs,
  product code (`server/src/...`) for real system bugs, or note the
  test-data/infra action for external drift (you generally can't re-seed a live
  account from here — hand that back to the user).
- Respect the project's product principles when touching product code: preserve
  verbatim external-data fidelity, keep operations idempotent/resumable, discover
  schemas dynamically, and never silently strip or swallow. See
  [`CLAUDE.md`](/CLAUDE.md) and
  [`CONNECTOR_GUIDE.md`](/server/src/remote-service/connectors/CONNECTOR_GUIDE.md).
- After editing, run `yarn lint` and `yarn build` from the repo root (per the
  project rules) and report results. Do NOT run `prisma migrate` — only
  `prisma generate` if needed.
- Tell the user how to verify the failing suites locally with the per-suite
  `yarn run test:integration <suite> -t "<name>"` commands from step 4 (these
  need Postgres, migrations, and a configured `server/.env.integration`; live
  suites need the matching API key). Be honest about what you could and could not
  verify — you usually can't reproduce a live-connector or post-deploy failure
  without the real keys and environment, so don't claim a green run you didn't
  observe.
- Do not commit or push unless the user asks — leave the changes in the working
  tree for review.

## Important guidelines

- **The job name drives triage.** A live-connector failure in the post-deploy
  job has an extra suspect — the external service / test-account data — that the
  in-process `integration test server` job does not. Always note which job ran.
- **Read before concluding.** Open the failing spec and the `src/...` code from
  the stack frame before declaring test-bug vs system-bug vs drift. A name-based
  guess is not a verdict.
- **Don't edit during the investigation phase.** This skill investigates and
  plans; it stops for plan approval and a safe working environment before editing.
- **Surface environment failures honestly.** If migrate or the Postgres service
  failed, say the suite likely never ran — don't manufacture per-test verdicts
  from a setup failure.
- **A real system bug is the serious finding.** Per the project's product
  principles (external-data fidelity, dynamic schema discovery, idempotent/
  resumable operations, surface-don't-swallow), treat a genuine server/connector
  regression as higher priority than a stale test or snapshot, and say so plainly.
- **Keep the log out of context.** Save the trace to the scratchpad and grep it;
  don't paste the entire multi-thousand-line log into the conversation.
