# Local GitLab Runner

Run MR pipeline jobs on your local machine for faster feedback instead of waiting for shared runners.

## Why

GitLab shared runners can be slow. A local runner lets your MR build-and-test jobs execute on your own machine, cutting feedback time significantly.

## How it works

- All MR jobs have hidden YAML templates in `gitlab-ci/stages/01-build-and-test.yml`.
- `gitlab-ci/local-runners.yml` defines "local" variants that extend those templates with your runner's tag.
- Tags use `local-$GITLAB_USER_LOGIN` so only **your** runner picks up **your** jobs.
- Users who opt in have their shared-runner MR jobs replaced by local-runner jobs. Shared runners are still used for master/prod merges.
- If your laptop is offline, local jobs will be stuck pending. You can cancel them and re-run, or remove your username from the opt-in lists.

## Setup

### 1. Install the GitLab Runner

```bash
brew install gitlab-runner
```

### 2. Create the runner in GitLab

1. Go to [New project runner](https://gitlab.com/whalesync/spinner/-/runners/new)
2. In the **Tags** field, enter `local-YOUR_GITLAB_USERNAME` (e.g., `local-jdoe`). This is how GitLab matches your MR jobs to your runner.
3. Click **Create runner** and copy the token it gives you

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
    volumes = ["/cache", "/var/run/docker.sock:/var/run/docker.sock"]
```

- **`privileged = true`** is required for service containers (e.g., postgres for integration tests).
- **`pull_policy = ["if-not-present"]`** avoids re-pulling cached images on every job, which speeds things up.
- **`wait_for_services_timeout = 120`** gives service containers more time to start on Docker Desktop.
- **`/var/run/docker.sock` mount** — Docker image build jobs use the host Docker socket instead of Docker-in-Docker (DinD). DinD service containers have networking issues on Docker Desktop for Mac that prevent health checks from succeeding.

### 5. Install and start the runner

```bash
gitlab-runner install
gitlab-runner start
```

### 6. Add your username to the opt-in lists

Add your GitLab username to the regex in two places:

1. **`gitlab-ci/stages/01-build-and-test.yml`** — `.rules.skip_for_local_runner_users`:

   ```yaml
   - if: '$CI_PIPELINE_SOURCE == "merge_request_event" && $GITLAB_USER_LOGIN =~ /^(cfonger|YOUR_USERNAME)$/'
     when: never
   ```

2. **`gitlab-ci/local-runners.yml`** — `.rules.local_runner_users`:
   ```yaml
   - if: &local-user-if '$CI_PIPELINE_SOURCE == "merge_request_event" && $GITLAB_USER_LOGIN =~ /^(cfonger|YOUR_USERNAME)$/'
   ```

## Integration tests

The `local integration test server` job runs identically to the shared-runner version — it spins up a postgres:16 service container and uses it for migrations and tests. No local PostgreSQL is needed.

## Opting out

Remove your username from the two opt-in lists (`.rules.skip_for_local_runner_users` and `.rules.local_runner_users`) and your MR jobs will go back to shared runners.

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
  gitlab-runner stop
  docker volume prune
  gitlab-runner start
  ```

**Integration test DB connection refused**

- The Postgres service container should start automatically. Check Docker logs for the job's service containers.
