# Maintenance Mode for Scratch

- **Created:** 2026-09-17
- **Author:** Chris Hoefgen
- **Status:** applied to `spv1eu-test` and exercised there on 2026-09-18. Not yet applied to `spv1eu-production`.
- **Operating instructions:** [runbook-maintenance-mode.md](../runbook-maintenance-mode.md)

## Problem

Critical work on Postgres, Redis, or the scratch-git VM needs Scratch to be offline in a controlled way. During such a window:

- `app.scratch.md` must show a maintenance page.
- Every REST, MCP, and WebSocket call must get a standard "service unavailable" HTTP error.
- Nothing in the background may keep reading or writing the datastores.
- A developer must be able to switch it on and off easily.
- The switch must not depend on Postgres or Redis, because they may be the thing under maintenance.

What existed before was a client-only switch. The Terraform variable `maintenance_mode_enabled` set `MAINTENANCE_MODE_ENABLED` on `client-service`, and `client/src/proxy.ts` redirected every request to `client/public/maintenance.html`. It required a `terraform apply` and a new Cloud Run revision, answered with a 307 instead of a 503, and did nothing for `api.scratch.md`, MCP, or background jobs.

## GCP environments involved

| Environment | Project | Hosts |
| --- | --- | --- |
| Test | `spv1eu-test` | `test.scratch.md`, `test-api.scratch.md` |
| Production | `spv1eu-production` | `app.scratch.md`, `api.scratch.md` |

Both are in `europe-west1`. Each host has its own global external Application Load Balancer built by `terraform/modules/cloudrun_lb`, in front of a Cloud Run service whose ingress is restricted to the load balancer.

## Two findings that shaped the design

1. **The API cannot serve its own 503 when Postgres is down.** `server/src/db/db.service.ts` calls `process.exit(1)` when the database connection fails at boot. Any new or recycled instance crash-loops. An application-level gate would disappear in exactly the situation it exists for, so the switch has to live outside the application.
2. **Blocking HTTP is not enough.** `worker-service` runs BullMQ jobs and `cron-service` runs the scheduler and the reapers, all against Postgres, Redis, and scratch-git. `api-service` holds a Prisma pool and several Redis connections, and a routine driver blocked in `waitUntilFinished` times out and cancels its job if the worker disappears for long (`server/src/routine/routine-executor.service.ts`).

## Summary of the change

```
                      terraform/tools/maintenance_mode.sh <env> on | resume-backends | off | status
                                   |                                        |
               Layer 1: LOCKDOWN (Cloud Armor)               Layer 2: QUIESCE (Cloud Run manual scaling)
                                   |                                        |
  user --> load balancer --> rule 100  bypass IPs : allow ----> backends    cron-service    --scaling=0
           (client, api)     rule 1000 everyone   : deny(502)               worker-service  --scaling=0
                                   |                                        api-service     --scaling=0
                     URL map custom error response                          (client-service keeps running)
                     502 -> 503 + /maintenance/index.html  (client host)
                     502 -> 503 + /maintenance/api.json    (api host: REST, MCP, WebSocket upgrade)
```

Both layers are GCP control-plane changes. Flipping them needs no Terraform apply, no new Cloud Run revision, and neither datastore.

### Layer 1: lockdown

- One Cloud Armor backend security policy per environment, `eu-<env>-maintenance`, attached to the client and API backend services.
- Rule 1000 matches all traffic. It is `allow` at rest and the script flips it to `deny(502)`.
- Rule 100 is an IP allowlist that still reaches the real backends, so a developer can verify the app before reopening it.
- Each URL map gets a custom error response policy that matches 502, rewrites it to 503, and serves an object from the public static bucket: a self-contained HTML page on the client host and a JSON body shaped like `ScratchpadApiErrorResponse` on the API host.
- Terraform creates all of this but ignores the rule action, the preview flag, the allowlist, and the descriptions, because the script owns them at runtime.

### Layer 2: quiesce

- `gcloud run services update <service> --scaling=0` disables a service and `--scaling=auto` restores it. It is a service-level setting that creates no revision. Instances receive SIGTERM and run the existing graceful drain.
- Stop order: cron, worker, api. Start order: api, worker, cron. The job consumer must exist before the scheduler and the reapers start again.
- Terraform ignores the service-level `scaling` block on those three services so an apply cannot restart them mid-window.

### Tooling

`terraform/tools/maintenance_mode.sh` wraps both layers with confirmation prompts, propagation polling, an identity check that refuses read-only service accounts, and a guard that refuses to reopen onto an unhealthy API.

It also tells the developer Slack channel when a window starts, when it is fully active, when it is being turned off, when the hosts are verified open again, and when any of those operations fails. It uses the webhook in the environment's `SLACK_NOTIFICATION_WEBHOOK_URL` secret, which the server already uses. A Slack problem only produces a warning, so a window never depends on Slack.

## Key decisions

| Decision | Reasoning |
| --- | --- |
| Gate at the load balancer, not in the app | The server exits at boot without Postgres. The load balancer has no such dependency and also covers MCP and WebSockets for free. |
| Cloud Armor rule instead of swapping the URL map's backend | A rule update is a single call, supports an IP bypass and a no-impact preview mode, and leaves the URL maps untouched. |
| `deny(502)` rewritten to 503 | Cloud Armor can only deny with 403, 404, or 502. Matching 403 or 404 in the error policy would overwrite the app's real permission and not-found responses. The app never returns 502 itself. |
| Everything that touches the policy is created in sequence | Cloud Armor rejects any operation on a policy that is still being changed. The first `eu-test` apply attached the policy to both backend services at once and one attachment failed with `Security policy ... is not in a ready state`. Explicit `depends_on` now orders it: bypass rule, lockdown rule, client load balancer, API load balancer. |
| The script owns the state, Terraform ignores it | With the old mechanism a routine `terraform apply` silently ended a window. `ignore_changes` prevents that, and the flip no longer needs an apply. |
| Reuse the existing public static bucket | It avoids a second public bucket for Vanta and Oneleet to assess. A separate backend bucket keeps the static site's one-year immutable cache header away from the maintenance objects. |
| Scale `api-service` to zero as well | It stops routine drivers from timing out and cancelling jobs, stops Redis reconnect churn, and avoids crash loops if an instance recycles while Postgres is down. |
| Scale to zero instead of an app-level pause flag | A flag needs a running process and a new revision, and new revisions cannot boot without Postgres. Scaling is control-plane only. |
| Production flips limited to `role_operations@` | That group already holds `compute.securityAdmin`, `compute.admin`, and `run.admin`. No IAM change was needed. |
| Retire the old client switch | Two switches invite confusion during an incident. Removal is a follow-up once the new one is proven in production. |

### Why pausing background work is safe

Checked against the code, with Redis data intact:

- Interrupted jobs stay `active` in BullMQ and are re-dispatched by stalled-job recovery when a worker returns. Handlers resume from their checkpoints (`server/src/worker/bull-worker.service.ts`).
- Waiting jobs have no expiry (`server/src/worker-enqueuer/bull-enqueuer.service.ts`).
- The stale-job reaper leaves alone any `DbJob` whose BullMQ job is not terminal (`server/src/cron/stale-job-reaper.service.ts`).
- The scheduler computes the next run from the current time, so each schedule fires at most once after a pause, and `isWorkbookBusy` serialises the burst (`server/src/schedule/`).
- No alert policy is keyed on worker or cron instance counts.

### Alternatives considered

| Alternative | Why not |
| --- | --- |
| Extend the env-var switch to the API | Every flip creates a Cloud Run revision, and the API cannot boot to serve the 503 while Postgres is down. |
| PostHog feature flag | Adds a third-party dependency to a break-glass path and still needs a running API. |
| Flag object in Cloud Storage polled by the server | A new runtime pattern, and it also needs a running API. |
| Swap the URL map default service to a bucket | A bucket answers 200, not 503, and offers no bypass. |
| URL map fault injection (abort 503) | No bypass, a clumsier flip, and custom error pages are not guaranteed for responses generated by the front end. |

## Known limitations

- Google does not apply custom error responses to requests that carry an `Authorization` header. Authenticated API and MCP callers get a generic error body instead of the JSON. They still receive a 5xx and never a 401 or 403. Whether the status is 503 or 502 for them must be measured in the test environment. Every first-party client treats the two identically. If an exact 503 with JSON ever becomes mandatory for authenticated calls, the fallback is a tiny static responder service that the API URL map points to during a window.
- Custom headers are not applied to custom error responses, so there is no `Retry-After` and no security headers on maintenance responses.
- Cloud Armor backend policies are skipped on CDN cache hits. The script invalidates the client cache when a window starts. Only static assets and prerendered public pages are cacheable.
- Replacing the lockdown rule resource in Terraform resets it to `allow`.

## Operation examples

```bash
# What is the current state? (read-only, any identity)
terraform/tools/maintenance_mode.sh production status

# Zero-impact dry run: log would-be denials, block nothing
terraform/tools/maintenance_mode.sh production on --preview
terraform/tools/maintenance_mode.sh production off

# A full window
terraform/tools/maintenance_mode.sh production on                 # lock down, then stop cron, worker, api
#   ... do the maintenance work ...
terraform/tools/maintenance_mode.sh production resume-backends    # start api, worker, cron; still locked down
#   ... smoke test from a bypassed IP ...
terraform/tools/maintenance_mode.sh production off                # verify API health, reopen

# Block the public but keep the backends running
terraform/tools/maintenance_mode.sh test on --lockdown-only --allow-ip 203.0.113.7,198.51.100.0/24
```

## Rollout

1. Apply to `spv1eu-test`. The plan must show additions plus in-place updates on two backend services, two URL maps, and three Cloud Run services, with zero replacements.
2. Run the verification in the test environment: lockdown only, the `Authorization` header measurement, bypass, a full window with a pull job in flight, resume, and off. Record propagation times and the measured status code in the runbook.
3. Apply to `spv1eu-production` in quiet hours. Run `on --preview` first, then a short announced real window checked from a network that is not bypassed.
4. Remove the old client switch: the check in `client/src/proxy.ts`, `client/public/maintenance.html`, and the `maintenance_mode_enabled` variable in Terraform. The Terraform removal goes in its own merge request.
5. Move this plan to `resolved/`.

## Cost

Cloud Armor Standard needs no enrolment. One policy with three rules costs about $8 per project per month, plus $0.75 per million requests evaluated.

## Follow-ups

- Friendlier copy in the CLI and the desktop splash for a 502 or 503 during maintenance.
- A deferral path for 5xx responses in Whalesync's server-side Scratch client, which today retries once and then drops a subscription update.
- An alert for "background processing is not running". Nothing detects a failed resume today.
- Hardening for hazards that predate this work and bite only on data loss: the stale-job reaper treats a missing BullMQ job as a dead job, the staging-directory reaper trusts an empty `DbJob` result, and scratch-git's boot-time staging sweep ignores its own maintenance switch.
- An edge security policy to close the CDN cache-hit gap, if it ever matters.
