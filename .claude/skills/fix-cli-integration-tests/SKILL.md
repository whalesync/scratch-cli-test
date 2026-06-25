---
name: fix-cli-integration-tests
description: Investigate and fix failed CLI integration tests from a GitLab pipeline. Accepts either a failed job URL or a pipeline URL (resolving the failed "cli integration tests" job within it). Pulls the failed job's log, identifies which scratch-cli-tests suites/tests failed, correlates against recent master commits, decides whether each failure is a test bug or a real system bug, and presents a fix plan. Use when the user reports a failed "cli integration tests" job or pastes a GitLab job or pipeline URL for one.
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

# Fix Failed CLI Integration Tests

Investigate a failed **CLI integration tests** GitLab job, pinpoint the failing
tests in the [`scratch-cli-tests`](/scratch-cli-tests) submodule, find likely
causes in recent `master` history, decide whether each failure is a test problem
or a real system bug, and present a fix plan.

These tests are black-box Jest suites that shell out to the compiled `scratchmd`
Rust binary against a remote Scratch stack. They run only on the scheduled
pipeline named "Scheduled CLI Tests" (see
[`gitlab-ci/stages/01-cli-integration-tests.yml`](/gitlab-ci/stages/01-cli-integration-tests.yml)).
A failure means either the tests drifted from CLI/server behavior, or a recent
change broke real CLI/server/scratch-git functionality.

## Inputs

- **gitlab-url** (argument, optional): either
  - a **job URL**, e.g. `https://gitlab.com/whalesync/spinner/-/jobs/15035566117`, or
  - a **pipeline URL**, e.g. `https://gitlab.com/whalesync/spinner/-/pipelines/2629246850`,
    which contains the failed `cli integration tests` job.

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
  ID, then list its jobs and find the failed `cli integration tests` job:

  ```
  glab api "projects/whalesync%2Fspinner/pipelines/<PIPELINE_ID>/jobs"
  ```

  From the JSON, pick the job whose `name` is exactly `cli integration tests`.
  Use its `id` as the job ID. Notes:
  - Prefer a job with `status` of `failed`. If that job is `success`, tell the
    user the CLI integration tests passed in that pipeline and confirm they have
    the right pipeline before continuing.
  - Ignore the `notify slack on cli integration test failure` job — it's a
    notifier, not the test run.
  - If no `cli integration tests` job exists in the pipeline, tell the user this
    pipeline didn't run the CLI integration tests (they only run on the scheduled
    "Scheduled CLI Tests" pipeline) and ask for the correct URL.
  - If the endpoint paginates and the job isn't on the first page, append
    `?per_page=100` to the query.

### 2. Pull the failed job's log

Fetch the full job trace via the API (works for completed jobs; `glab ci trace`
is geared toward live jobs):

```
glab api projects/whalesync%2Fspinner/jobs/<JOB_ID>/trace
```

The trace can be large. Save it to the scratchpad and work from the file rather
than dumping the whole thing into context:

```
glab api projects/whalesync%2Fspinner/jobs/<JOB_ID>/trace > <scratchpad>/job-<JOB_ID>.log
```

If the API call fails:
- A `404` usually means a bad job ID or the project slug is wrong — re-check the
  URL with the user.
- Otherwise, fall back to `glab ci trace <JOB_ID>` and report what you see.

Confirm the log is actually for a **cli integration tests** job (look for
`yarn test:integration`, `scratch-cli-tests`, or the Jest summary). If it's a
different job type, tell the user this skill is for CLI integration tests and
ask for the correct URL.

### 3. Identify the failed tests

Parse the Jest output in the log. Jest's `--runInBand` output marks failures
with `✕` / `FAIL <file>` and lists them in a `Summary of all failing tests`
block near the end. For each failure capture:

- The **suite file** (e.g. `tests/publish.spec.ts`).
- The **test name(s)** (the `describe` > `it` path).
- The **assertion / error** (expected vs received, thrown error, timeout, or a
  CLI non-zero exit with stderr).
- Whether it's an **environment/setup failure** (global-setup health check, auth,
  `DATABASE_URL`, server unreachable, cargo build) vs a genuine **test
  assertion** — these are triaged very differently in step 6.

Cross-reference each failing suite against the actual files in
[`scratch-cli-tests/tests/`](/scratch-cli-tests/tests/) and the suite table in
[`scratch-cli-tests/README.md`](/scratch-cli-tests/README.md) so you describe
what each one is supposed to validate.

### 4. Summarize failures BEFORE deep investigation

Present a concise summary to the user and pause here for a beat — this is the
checkpoint before the deep dive. Include:

- A short table: failing suite, failing test name, one-line failure reason,
  and a first-glance category (assertion failure / CLI error / timeout /
  environment-setup). Mark environment-setup failures clearly — if everything
  failed in global setup, the tests themselves may be fine and the run was
  simply misconfigured or pointed at a down server.
- Total counts: N suites failed, M individual tests failed.

Then give **copy-pasteable instructions to run just the failed tests locally**.
The suites need a running Scratch server, scratch-git, a reachable Postgres, and
a configured `.env.integration` (see the README's Prerequisites — flag any of
these the user must have up):

```bash
# From the repo root
nvm use                      # tests need Node >= 22
cd scratch-cli-tests
# cp .env.integration.example .env.integration  # if not already configured

# Run only the failing suite(s) — pass the suite file basename(s) as a filter:
npx jest --runInBand --forceExit publish
# Run a single test within a suite by name:
npx jest --runInBand --forceExit publish -t "<exact test name or substring>"
```

List one command per failing suite, substituting the real suite basename
(without `.spec.ts`) and, where useful, a `-t "<name>"` for the specific test.
`yarn test:integration` runs everything; the per-suite filter is faster for
iterating on a fix.

### 5. Scan the last 48 hours of master commits for likely causes

Look at recent `master` history in the **main `spinner` repo** for changes that
could plausibly have broken the failing suites:

```
git fetch origin master
git log --since="48 hours ago" origin/master --oneline --stat
```

For richer context on suspicious commits, use
`git log --since="48 hours ago" origin/master -p -- <path>` scoped to the
relevant areas. Focus the correlation on paths that drive these tests:

- `scratch-git-2/` — the Rust `scratchmd` CLI and git service (the binary under
  test). Most CLI-behavior regressions live here.
- `server/` — especially publish, sync, pull, validators, files, routines, and
  workspace endpoints the CLI calls.
- `scratch-cli-tests/` — changes to the tests themselves (a test edit that
  doesn't match current behavior is a common cause).
- `gitlab-ci/` — CI/env changes that could break setup.

Note: the CLI integration tests run on a **schedule** and exercise a **remote**
Scratch stack, so the breaking change may already be deployed to that
environment. Map each failing suite to the commits that touched its
corresponding code path and call out the most likely culprits with commit
hashes and subjects.

### 6. Decide: test bug or real system bug

For each failure, reach a reasoned verdict — read the actual test source and the
implicated code, don't guess from the name alone:

- **Test bug** — the test encodes an outdated assumption (renamed flag, changed
  JSON shape/key, new required arg, tightened/loosened schema, timing/ordering,
  hardcoded value). The CLI/server behavior is correct; the test must be updated.
  Watch for the CLI argument-syntax gotchas documented at the bottom of
  [`scratch-cli-tests/README.md`](/scratch-cli-tests/README.md) (parent-level
  `--workspace`, positional `workspaces create` name, no `--json` on
  delete/remove, `workbooks` key, comma-joined table IDs, etc.).
- **Real system bug** — the test is asserting correct behavior and the CLI,
  server, or scratch-git now does the wrong thing (wrong output, error, data
  corruption, broken round-trip). This is the higher-severity outcome — the fix
  belongs in product code, and per the project's principles a regression here may
  mean a publish/sync/pull correctness or fidelity problem.
- **Environment / flaky** — global-setup failure, server down, missing
  `DATABASE_URL`, network timeout, or an order-dependent flake. Call it out as
  not-a-code-bug and note what infra/config needs attention, but don't paper over
  a genuine assertion failure as "flaky" without evidence.

Tie the verdict back to the step-5 commit correlation where possible
("`publish.spec.ts` fails because <hash> changed the accepted-patches JSON shape;
the test still expects the old key — test bug").

### 7. Present the fix plan and offer a worktree/branch

Lay out a concrete plan: for each failure, the verdict, the file(s) to change
(test vs product code), and the specific change. Order by severity — real system
bugs first.

Then handle the working environment. Determine whether you're already on a
dedicated branch/worktree:

- A worktree is in use if `git rev-parse --git-common-dir` differs from
  `git rev-parse --git-dir`.
- Otherwise check the branch: `git rev-parse --abbrev-ref HEAD`. If it's `master`
  (or another protected branch), you are NOT on a safe working branch.

If you are already on a non-`master` branch or in a worktree, say so and proceed
with the plan there. **If you are on `master` (and not in a worktree), prompt the
user** asking whether they'd like a dedicated branch and/or worktree created for
the fix before any edits — and let them choose. Suggest a descriptive name such
as `fix-cli-integration-tests-<YYYY-MM-DD>`. Do not create the branch/worktree
or start editing until the user has answered.

## Important guidelines

- **Read before concluding.** Always open the failing test source and the
  implicated product code before declaring test-bug vs system-bug. A name-based
  guess is not a verdict.
- **Don't edit anything in this skill's investigation phase.** This skill
  investigates and plans; it stops to confirm the working environment before
  making changes.
- **Surface environment failures honestly.** If the whole run died in global
  setup or the server was down, say the tests likely never ran — don't
  manufacture per-test verdicts from a setup failure.
- **A real system bug is the serious finding.** Per the project's product
  principles (round-trip fidelity, idempotent/resumable operations, user-in-
  control publishing), treat a genuine CLI/server/scratch-git regression as
  higher priority than a stale test, and say so plainly.
- **Keep the log out of context.** Save the trace to the scratchpad and grep it;
  don't paste the entire multi-thousand-line log into the conversation.
