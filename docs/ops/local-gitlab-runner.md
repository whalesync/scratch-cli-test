# Local GitLab Runner

Run MR pipeline jobs on your local machine for faster feedback instead of waiting for shared runners. **One runner registration at the `whalesync` GitLab group level covers both `whalesync/spinner` and `whalesync/whalesync`** — register once, opt in per-repo.

## Why

GitLab shared runners can be slow. A local runner lets your MR build-and-test jobs execute on your own machine, cutting feedback time significantly.

## How it works

- All MR jobs have hidden YAML templates (in `gitlab-ci/stages/01-build-and-test.yml` for spinner, `gitlab-ci/stages/02-build-and-test.yml` for whalesync).
- A `gitlab-ci/local-runners.yml` in each repo defines "local" variants that extend those templates with your runner's tag.
- Tags use `local-$GITLAB_USER_LOGIN` so only **your** runner picks up **your** jobs.
- The runner is registered at the `whalesync` GitLab **group** level, so it's eligible for jobs from both spinner and whalesync. The tag filter still scopes claims to your own jobs.
- Users who opt in have their shared-runner MR jobs replaced by local-runner jobs. Shared runners are still used for master/prod merges.
- If your laptop is offline, local jobs will be stuck pending. You can cancel them and re-run, or remove your username from the opt-in lists.

## Setup

### 1. Install the GitLab Runner

```bash
brew install gitlab-runner
```

### 2. Create the group runner in GitLab

A **group** runner is registered against the `whalesync` group rather than a single project, so it's eligible for jobs from any project in the group (spinner, whalesync, etc.). Despite the name, it's still _your_ runner on _your_ machine; the `local-$USER` tag enforces that only your own jobs run on it.

1. Go to [New group runner](https://gitlab.com/groups/whalesync/-/runners/new). You need **Maintainer** role on the `whalesync` group; if you don't have it, ask an Owner.
2. In the **Tags** field, enter **`local-YOUR_GITLAB_USERNAME`** (e.g., `local-jdoe`) **and `local-docker`**, comma-separated. The username tag routes jobs to your machine; **`local-docker` marks this as the Docker-executor runner** so the spinner `local smoke tests` job (which requires both tags) does not get picked up by a shell-executor runner registered with the wrong tags.
3. Leave **Run untagged jobs** off, **Lock to current projects** off, and **Protected** off (unless you specifically want to handle protected branches).
4. Click **Create runner** and copy the authentication token (`glrt-…`) — it's only shown once.

> **Migrating from a spinner project runner?** If you already have a project-scoped spinner runner, see [Migrating an existing project runner](#migrating-an-existing-project-runner) below before unregistering anything.

### 3. Register the runner locally

```bash
gitlab-runner register \
  --url https://gitlab.com \
  --executor docker \
  --token YOUR_TOKEN_FROM_STEP_2
```

When prompted for a default Docker image, any value works (e.g., `alpine:latest`) — the actual images are defined in `gitlab-ci/common.yml` and always override the runner's default.

### 4. Configure the runner

Edit `~/.gitlab-runner/config.toml` and update `[runners.docker]`:

```toml
[[runners]]
  # ...
  [runners.docker]
    privileged = true
    pull_policy = ["if-not-present"]
    wait_for_services_timeout = 120
    volumes = ["/cache", "/var/run/docker.sock:/var/run/docker.sock", "gitlabbuilds:/builds"]
```

- **`privileged = true`** is required for service containers (e.g., postgres for integration tests).
- **`pull_policy = ["if-not-present"]`** avoids re-pulling cached images on every job, which speeds things up.
- **`wait_for_services_timeout = 120`** gives service containers more time to start on Docker Desktop.
- **`/var/run/docker.sock` mount** — Docker image build jobs use the host Docker socket instead of Docker-in-Docker (DinD). DinD service containers have networking issues on Docker Desktop for Mac that prevent health checks from succeeding.
- **`gitlabbuilds:/builds` volume** — Persists the build directory across job runs so that `GIT_STRATEGY: fetch` can reuse the existing repo and caches (like `node_modules`, `.yarn`, and `.next`) survive between builds. Uses a named Docker volume so `docker volume prune` clears it along with other caches.

### 5. Start the runner

If you installed via Homebrew (step 1):

```bash
brew services start gitlab-runner
```

> Do **not** run `gitlab-runner install`. That command creates a second launchd plist (`gitlab-runner.plist`) that fights the Homebrew plist (`homebrew.mxcl.gitlab-runner.plist`) for the same registration token. The symptom is `error: cannot lock ref 'refs/remotes/origin/master'` during git fetch when both runners pick up the same job. If you've already run it, see the **Duplicate launch agent** note in the Troubleshooting section below for cleanup steps.

### 6. Add your username to the opt-in lists

Each repo has its own opt-in lists. **Update only the repo(s) you want to route jobs from** — you can opt into spinner and skip whalesync, or vice versa. Both repos have a `✏️` comment marking the spot.

#### Spinner (`whalesync/spinner`)

Two files:

1. **`gitlab-ci/common.yml`** — add your username to the `.rules.local_runner_users_mr` regex:

   ```yaml
   local_runner_users_mr: "... && $GITLAB_USER_LOGIN =~ /^(cfonger|YOUR_USERNAME)$/"
   ```

2. **`gitlab-ci/stages/01-build-and-test.yml`** — `.rules.skip_for_local_runner_users` (suppresses shared-runner duplicates):

   ```yaml
   - if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $GITLAB_USER_LOGIN =~ /^(cfonger|YOUR_USERNAME)$/'
     when: never
   ```

> The macOS shell runner used for desktop releases does **not** require username opt-in — it's dispatched by the shared `team-macos-release` tag instead. See [§ macOS Shell Runner](#macos-shell-runner-for-native-dmg-builds) below.

#### Whalesync (`whalesync/whalesync`)

One file: **`gitlab-ci/common.yml`** holds all four regexes (`local_runner_users_{mr,master,prod}` plus `skip_for_local_runner_users`). Add your username to all four. See `whalesync/docs/local-gitlab-runner.md` for the short version.

You **must** update both spots in whichever repo you're opting into. If you only update one, you'll get duplicate jobs or no jobs at all.

## Docker Desktop memory

Docker Desktop on macOS allocates only ~7-8 GiB of host RAM to its VM by default. That's not enough for whalesync's bottlenose jest test suite — the OOM killer reaps jest workers mid-run and you get cryptic failures like:

```
A jest worker process (pid=...) was terminated by another process: signal=SIGKILL
```

Bump it before running whalesync's `local build and test bottlenose` for the first time:

1. Docker Desktop → **Settings** → **Resources** → **Advanced** → **Memory**.
2. Drag to **16 GB** (assuming your host has at least 24 GB RAM; otherwise allocate at least 12 GB).
3. **Apply & restart**.
4. Verify with `docker info | grep -i 'total memory'`.

CPU allocation is fine at the default — Docker grabs all host cores.

## Migrating an existing project runner

If you previously registered a project-scoped spinner runner (per the older version of this doc), you have two options:

**Parallel registration (zero-downtime).** Register the new group runner alongside the old project one. Both will pick up jobs in their respective scopes. Once you confirm the group runner works against both repos, unregister the old project runner.

**Clean swap.** Stop, unregister, and re-register against the group token:

```bash
gitlab-runner list                                # find the project-scoped runner's name
gitlab-runner unregister --name <that-name>
brew services restart gitlab-runner
```

Then in the GitLab UI, delete the now-orphaned project runner record at `gitlab.com/whalesync/spinner/-/runners` so it doesn't appear offline forever.

## macOS Shell Runner (for native .dmg builds)

The default Docker-executor runner builds everything inside Linux containers, so it can't produce macOS `.dmg` files. A second runner using the **shell executor** runs jobs directly on macOS, enabling native `.dmg` + `.zip` builds for the desktop app.

### 1. Create the runner in GitLab

1. Go to [New project runner](https://gitlab.com/whalesync/spinner/-/runners/new)
2. In the **Tags** field, enter both `local-macos-YOUR_GITLAB_USERNAME` (e.g., `local-macos-jdoe`) and `team-macos-release` — comma-separated. The first tag is for personal MR jobs; the second lets this runner pick up team-wide prod/test desktop releases regardless of who triggered the pipeline.
3. Click **Create runner** and copy the token

### 2. Register the runner locally

```bash
gitlab-runner register \
  --url https://gitlab.com \
  --executor shell \
  --token YOUR_TOKEN_FROM_STEP_1
```

### 3. Prerequisites

The shell executor runs jobs directly on your Mac, so these tools must be available in the runner's shell:

- **Node.js 22** — via `nvm` or `brew install node@22`
- **Yarn** — `brew install yarn` or `npm install -g yarn`
- **Git** — pre-installed on macOS

If you use `nvm`, ensure it's loaded in your shell profile (`~/.zshrc` or `~/.bash_profile`) so the runner can find `node` and `yarn`:

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
```

### 4. Usage

No additional opt-in is needed — the macOS jobs use the same username list as the Docker local runner. Once your runner is registered and running, the `TEST: Release desktop macOS app [Local Runner] (… version)` manual jobs in MR pipelines will be picked up by it.

These jobs build `.dmg` + `.zip` for macOS (no Linux targets) and create a GitHub test release, just like the Docker-based release jobs but with native macOS packaging.

> **Note:** This runner is only used for desktop release jobs. All other local jobs (client, server, scratch-cli, etc.) continue to use the Docker-executor runner.

### 5. Cap concurrency in `config.toml`

The shell runner builds an Electron app on your laptop, which is heavy. Add `limit = 1` to the shell runner block in `~/.gitlab-runner/config.toml` so it only takes one job at a time even when multiple team-tagged release jobs are queued:

```toml
[[runners]]
  name = "your-machine.shell"
  executor = "shell"
  # ...
  limit = 1
```

Then restart the runner:

```bash
brew services restart gitlab-runner
```

### Adding the team tag to an existing runner

If you registered a macOS shell runner before the `team-macos-release` tag existed, add it via the GitLab UI:

1. Go to [Project runners](https://gitlab.com/whalesync/spinner/-/settings/ci_cd) → expand **Runners** → click your runner's edit (pencil) icon.
2. In the **Tags** field, append `team-macos-release` (comma-separated with your existing `local-macos-…` tag).
3. Save.

No runner restart is required — GitLab tracks tags server-side. Also add `limit = 1` to `config.toml` (above) if you haven't already.

## Integration tests

The `local integration test server` job runs identically to the shared-runner version — it spins up a postgres:16 service container and uses it for migrations and tests. No local PostgreSQL is needed.

## Opting out

Remove your username from the opt-in lists in whichever repo you want to roll back. For spinner that's `gitlab-ci/common.yml` (the three `local_runner_users_*` regexes) plus `gitlab-ci/stages/01-build-and-test.yml` (`skip_for_local_runner_users`). For whalesync it's all four regexes in `gitlab-ci/common.yml`. Your MR jobs go back to shared runners on the next pipeline.

## Troubleshooting

**Jobs stay pending / not picked up**

- Verify the runner is online: `gitlab-runner status`
- Check the tag matches: `gitlab-runner list` should show `local-YOUR_GITLAB_USERNAME`
- Ensure the runner is registered to the correct project/group

**Docker pull errors**

- Make sure Docker Desktop is running.
- The first run will pull the CI images, which may take a few minutes. Subsequent runs use the local cache.

**Jobs fail but would pass on shared runners**

- Check `gitlab-runner --debug run` for detailed logs.
- Verify your local Docker environment matches what the CI image provides.

**Corrupted yarn cache / node_modules**

- Local runner jobs preserve `node_modules` and `.yarn` between runs for speed. If a job fails with a corrupt cache error, clear the Docker build volumes and retry:
  ```bash
  brew services stop gitlab-runner
  docker volume prune
  brew services start gitlab-runner
  ```
  > If you installed gitlab-runner manually instead of via Homebrew, use `gitlab-runner stop/start` instead. The `gitlab-runner` CLI's stop/start targets a launchd label called `gitlab-runner`, while Homebrew's plist is `homebrew.mxcl.gitlab-runner` — running the wrong one triggers `launchctl: Input/output error`.

**Docker Desktop VM disk full**

- Symptoms: `apt-get` inside container jobs fails with `"At least one invalid signature was encountered"` or other obscure errors; `docker run` fails with no free space. Docker Desktop's internal VM disk is separate from your Mac's filesystem and fills up silently. Reclaim with `docker system prune -a --volumes` (stop the runner first). To catch this proactively, install the [Docker disk monitor](local-dev/docker-disk-monitor.md) — a LaunchAgent that alerts when the VM disk hits 90%.

**Integration test DB connection refused**

- The Postgres service container should start automatically. Check Docker logs for the job's service containers.

**Jest workers killed by SIGKILL (whalesync bottlenose)**

- Symptoms: `local build and test bottlenose` runs for 5–15 minutes, then fails with `A jest worker process (pid=...) was terminated by another process: signal=SIGKILL`. This is the OOM killer. Bump Docker Desktop memory to 16 GB — see [Docker Desktop memory](#docker-desktop-memory) above.

**Duplicate launch agent**

- Symptoms: `gitlab-runner restart` fails with `launchctl: Unload failed: 5: Input/output error`, or jobs fail with `error: cannot lock ref 'refs/remotes/origin/master'` during git fetch. Caused by two `gitlab-runner` processes running at once — typically a Homebrew launch agent (`homebrew.mxcl.gitlab-runner.plist`) plus a manually installed one (`gitlab-runner.plist`) both claiming the same registration token. Keep the Homebrew one and remove the manual one:
  ```bash
  launchctl unload ~/Library/LaunchAgents/gitlab-runner.plist 2>/dev/null
  rm ~/Library/LaunchAgents/gitlab-runner.plist
  brew services restart gitlab-runner
  ```
  Verify only one process is alive: `ps aux | grep gitlab-runner | grep -v grep` should show exactly one row.
