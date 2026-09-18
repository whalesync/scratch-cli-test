# Runbook: Maintenance Mode

How to take Scratch offline safely for critical work on Postgres, Redis, or the scratch-git VM, and how to bring it back. One script, [`terraform/tools/maintenance_mode.sh`](/terraform/tools/maintenance_mode.sh), drives everything. The design and the reasoning behind it live in the [maintenance mode plan](plans/2026-09-17-maintenance-mode-plan.md).

> Not to be confused with **scratch-git background maintenance** (the repo GC loop toggled at `/settings/dev/gc`). That is a separate switch. It appears in this runbook only as a checklist item.

## Context

| Item | Value |
| --- | --- |
| Environments | `test` (`spv1eu-test`: `test.scratch.md`, `test-api.scratch.md`) and `production` (`spv1eu-production`: `app.scratch.md`, `api.scratch.md`) |
| Who can flip it | Members of `role_operations@whalesync.com`. The per-dev `<alias>-readonly` laptop identities can run `status` only. |
| Depends on | Cloud Armor, the load balancers, and the Cloud Run control plane. **Not** Postgres, Redis, scratch-git, or a Terraform apply. |
| Terraform | [`terraform/modules/env/maintenance.tf`](/terraform/modules/env/maintenance.tf), [`terraform/modules/cloudrun_lb`](/terraform/modules/cloudrun_lb/main.tf), page and JSON body in [`terraform/modules/env/files/maintenance/`](/terraform/modules/env/files/maintenance/) |
| Time to take effect | Cloud Armor changes propagate in a few minutes. The script polls both hosts and tells you when the lockdown is real. |

## How it works

Maintenance mode has two layers. `on` applies both, in order.

1. **Lockdown** blocks the public at the load balancer. A Cloud Armor rule on both the client and API backends flips from `allow` to `deny(502)`. The URL maps rewrite that denial to **HTTP 503** and serve the maintenance page on the client host and a JSON error on the API host. MCP (`/mcp`, `/mcp-auth/*`) and the WebSocket gateway live on the API host, so they are covered. A bypass rule lets listed source IPs through to the real app.
2. **Quiesce** stops everything that touches Postgres, Redis, or scratch-git. `cron-service`, `worker-service`, and `api-service` are switched to Cloud Run manual scaling with 0 instances. This is a service-level setting: it creates no revision and needs no deploy. `client-service` keeps running because it uses none of those datastores.

The app cannot gate itself: the server exits at boot when Postgres is unreachable (`server/src/db/db.service.ts`), so any new instance would crash-loop instead of serving a 503.

### What each audience sees

| Audience | During a window |
| --- | --- |
| Browser on the client host | The maintenance page with HTTP 503. It reloads itself every 60 seconds. |
| REST and MCP callers | HTTP 503 with `{"statusCode":503,"error":"Service Unavailable","message":...}`. See [Known limitations](#known-limitations) for callers that send an `Authorization` header. |
| Desktop app | The "Can't reach Scratch" splash. Users press Reload after the window. |
| `scratchmd` CLI | `Error: Server error (503): ...` and a non-zero exit. Reads retry three times first. |
| Open web tabs | The WebSocket drops when `api-service` stops, reconnects fail, and the tab needs a reload afterwards. |
| Bypassed IPs | The real app. While the backends are stopped the API still returns 503 to them, because the service is disabled. |

Nothing returns 401 or 403, so no client logs out and no MCP token is invalidated.

## Commands

```bash
terraform/tools/maintenance_mode.sh <test|production> status
terraform/tools/maintenance_mode.sh <test|production> on [--allow-ip <cidr,...>|none] [--lockdown-only] [--preview] [--no-notify]
terraform/tools/maintenance_mode.sh <test|production> resume-backends [--no-notify]
terraform/tools/maintenance_mode.sh <test|production> off [--no-notify]
```

| Command | Effect |
| --- | --- |
| `status` | Read-only. Shows the lockdown state, who last changed it, the bypass list, backend scaling, and live probes of both hosts. It warns when your own IP is bypassed, because your probes then show what you see and not what the public sees. |
| `on` | Locks down, waits until both hosts really return 5xx, sets the bypass list (default: your public IPv4), then stops cron, worker, and api in that order. Production asks you to type `production`. |
| `on --lockdown-only` | Blocks the public but leaves the backends running. Use it when the work does not need the datastores quiet. |
| `on --preview` | Dry run. Cloud Armor logs the denials it would make and blocks nothing. Clear it with `off`. |
| `resume-backends` | Starts api, worker, and cron in that order while the lockdown stays on, so a bypassed developer can test before reopening. |
| `off` | Resumes any stopped backend, verifies `/health` through the bypass, reopens both hosts, and clears the bypass list. It refuses to reopen onto an unhealthy API. |

Requirements: an authenticated `gcloud` with a `role_operations@` identity, and a `gcloud` recent enough to know `gcloud run services update --scaling` (run `gcloud components update` if it rejects the flag).

### Slack notifications

The script posts to the developer Slack channel through the webhook stored in the environment's `SLACK_NOTIFICATION_WEBHOOK_URL` secret, the same webhook the server uses. Test and production each have their own secret value.

| Moment | Message |
| --- | --- |
| `on`, right after you confirm | Maintenance mode is starting, who started it, and whether the backends will be stopped |
| `on`, when everything is in place | Maintenance mode is ACTIVE: both hosts verified blocked, backends stopped (or left running), size of the bypass list |
| `off`, right after you confirm | Maintenance mode is being turned OFF, and by whom |
| `off`, when both hosts answer normally again | Maintenance mode is OFF |
| Any of `on`, `resume-backends`, `off` exits with an error | The operation did NOT complete, the reason, and the current lockdown state |

Things to know:

- Notifications never block a window. If the secret cannot be read, is not a Slack webhook URL, or Slack is down, the script prints a warning and carries on.
- The webhook URL is read into memory at run time. It is never printed, and it is passed to `curl` on stdin so it does not show up in the process list.
- `--preview`, and an `off` that only clears a preview, are not announced. Bypass addresses are never posted, only how many there are.
- Pass `--no-notify` to stay quiet, for example while rehearsing on test. The secret is then not read at all.

## Procedure

### Before the window

1. Announce the window and post it on [status.scratch.md](https://status.scratch.md). The maintenance page links there.
2. **Hold deploys.** A pipeline that runs mid-window executes `run_database_migrations.sh` against a database under maintenance. Pause the `AUTO_PUSH_PROD` schedule in [GitLab pipeline schedules](https://gitlab.com/whalesync/spinner/-/pipeline_schedules) and do not merge to the environment's deploy branch (`prod` for production, `master` for test).
3. Look at `/settings/dev/jobs` for long-running jobs. Anything still active when the worker stops is interrupted and re-run from its last checkpoint on resume, exactly as in a deploy. Waiting for a quiet moment is kinder to users but not required.
4. For work on the **scratch-git VM**, turn off its background GC loop at `/settings/dev/gc` first. Do this before `on`, or from a bypassed IP with `--lockdown-only`, because the dev tools need the API.
5. If the work takes Postgres, Redis, or the scratch-git VM down, snooze the matching `Scratch <env> DB ...`, `Redis ...`, and `Scratch Git ...` alert policies in the Cloud Monitoring console for the window. Several of them page. They are defined in [`monitoring.tf`](/terraform/modules/env/monitoring.tf).
6. Tell the Whalesync team. Their app calls the Scratch API from the browser and from a Stripe-driven server path.

### Start

```bash
terraform/tools/maintenance_mode.sh production status
terraform/tools/maintenance_mode.sh production on
```

Wait for `Lockdown is ON and the backends are stopped.` Then confirm from a network that is not bypassed, such as a phone on cellular, that `app.scratch.md` shows the maintenance page. Do not start the maintenance work until the script reports that both hosts are blocked. If it times out, run `status` and resolve that first.

### During

- Do the maintenance work.
- On production, expect the `Download - desktop server endpoint broken` and `Download - CLI server endpoint broken` alerts (warn tier: Slack and email) about ten minutes in. They clear on their own.
- On test, expect the post-deploy environment tests and the scheduled CLI tests to fail and post to Slack.
- To change the bypass list mid-window, run `on --allow-ip <new list>` again. It resets the list, confirms the lockdown, and applies the new list.

### End

1. Make sure Postgres and Redis accept connections. Backends started before that exit at boot.
2. `terraform/tools/maintenance_mode.sh production resume-backends`
3. From a bypassed IP, sign in and smoke test: open a workspace, run a pull, check `/settings/dev/jobs`.
4. `terraform/tools/maintenance_mode.sh production off`

### After the window

- Re-enable the `AUTO_PUSH_PROD` schedule and lift the merge hold.
- Re-enable the scratch-git GC loop if you turned it off. Remove alert snoozes.
- Check `/settings/dev/jobs` for jobs left `failed`. Interrupted jobs normally resume by themselves within a minute of the worker starting.
- Stripe and Shopify retry the webhooks they could not deliver. Check the Stripe dashboard for events still failing.
- Ask Whalesync to replay subscription changes made during the window. Their server client retries a 5xx once and then drops the update, so Scratch can miss a plan change.
- Update the status page.
- Run `terraform plan` for the environment and confirm it is clean.

## Special cases

- **Restoring Postgres from an older snapshot.** Keep `cron-service` stopped until you have checked the `DbJob` table. The staging-directory reaper treats a directory with no non-terminal `DbJob` as abandoned, so a rolled-back table can make live work look dead. Start api and worker by hand with `gcloud run services update <service> --scaling=auto`, verify, then start cron the same way.
- **Redis data loss.** The instance is BASIC tier unless `redis_enable_ha` is set, so a restart or version upgrade empties it. Queued and interrupted jobs are then really gone. On resume the stale-job reaper marks their `DbJob` rows failed and releases their folder locks, which is the correct outcome. Users re-run the work. MCP sessions and OAuth state are lost too, so MCP clients reconnect.
- **The window outlasts a webhook retry budget.** Shopify gives up after about four hours. Keep windows shorter, or plan a reconciliation.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `on` times out waiting for 5xx | Cloud Armor propagation is slow, or the policy is not attached. Run `status` and check the wiring section. The rule is already set to deny, so keep polling with `status` instead of re-running `on`. |
| `security policy ... was not found` | The Terraform in `maintenance.tf` has not been applied to that environment, or your identity cannot read it. |
| `resume-backends` or `off` reports the API never became healthy | Postgres or Redis is not accepting connections, so new instances exit at boot. Read the `api-service` logs, fix the datastore, run the command again. The lockdown stays on. |
| `gcloud` rejects `--scaling` | Old gcloud. Run `gcloud components update`. |
| A public page still renders during a window | A CDN cache hit. Cloud Armor backend policies are skipped on cache hits. `on` invalidates the client cache, and only prerendered public pages and static assets are cacheable at all. Re-run the invalidation from the console if it matters. |
| Maintenance ended by itself | Someone replaced or re-created the lockdown rule resource in Terraform, which resets it to `allow`. `ignore_changes` protects against a normal apply, not against a replacement. Run `on` again. |
| A backend came back during a window | Check whether someone deployed or changed scaling by hand. Manual scaling is a service-level setting that a new revision should not change, but a deploy during a window is untested and deploys are meant to be held. Check `status` and re-run `on`. |

## Known limitations

- **Callers that send an `Authorization` header do not get the JSON body.** The load balancer forwards request headers when it fetches the error object, and Cloud Storage rejects the foreign token, so Google serves a generic error body instead. Those callers still get a 5xx, never a 401 or 403. `status` probes this case explicitly. Record the measured status code here after the first test-environment run: _not yet measured_.
- No `Retry-After` header. Google does not apply custom headers to custom error responses.
- The maintenance responses do not carry the security headers the load balancer adds to normal responses, for the same reason.
- The bypass list is IPv4 only and holds at most ten CIDRs.
- Nothing alerts when background processing fails to come back. After `off`, confirm by hand that jobs run.
