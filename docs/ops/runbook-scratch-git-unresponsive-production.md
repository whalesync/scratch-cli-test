# Runbook: Unresponsive scratch-git Server (Production)

Guide for investigating when the production **scratch-git** GCE instance is hung or not responding, and for recovering by restarting the VM. This runbook implements the action item from [Postmortem: Scratch Git Server Unresponsive — Production Outage (2026-04-17)](postmortems/2026-04-17-scratch-git-unresponsive-prod-outage.md).

## Context

| Item          | Value                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GCP project   | `spv1eu-production`                                                                                                                                         |
| Instance name | `scratch-git`                                                                                                                                               |
| Zone          | `europe-west1-b`                                                                                                                                            |
| Service       | [scratch-git-2](../../scratch-git-2/docs/README.md) — REST API on **3100**, Git HTTP backend on **3101**, fronted on the VM by an **nginx** proxy container |

The NestJS API checks connectivity to scratch-git via [`https://api.scratch.md/service-check`](https://api.scratch.md/service-check), which reports `scratch_git` and `scratch_git_http` status and build versions.

**Typical failure mode:** the VM runs out of memory during a large pull/publish job; the instance may stop responding to SSH, and the Ops Agent may stop reporting metrics. Symptom patterns are documented in the postmortem above.

## Prerequisites

- Access to the `spv1eu-production` project in the [GCP Console](https://console.cloud.google.com/?project=spv1eu-production)
- `gcloud` CLI authenticated (e.g. user in `role_operations@whalesync.com`)
- Permission to stop/start the `scratch-git` VM and to use [IAP TCP forwarding](https://cloud.google.com/iap/docs/using-tcp-forwarding) for SSH (same as other production runbooks)

## Investigation

Work through these in order. Stop once you have enough signal to decide on a restart or escalate.

### 1. Test the web app (`app.scratch.md`)

Open [https://app.scratch.md](https://app.scratch.md) and confirm whether the UI loads and basic navigation works. Try opening a workbook and a file that is backed by git storage. If the app loads but git-backed operations fail or hang, that points at scratch-git or downstream services rather than only the static web tier.

### 2. Call the service-check endpoint

Fetch [https://api.scratch.md/service-check](https://api.scratch.md/service-check) (browser or `curl`). A healthy response includes JSON with `scratch_git` and `scratch_git_http` both reporting `"status":"ok"`, plus a `build_version` for each.

Example (values will differ at runtime):

```json
{
  "timestamp": "2026-04-20T14:25:57.186Z",
  "redis": { "status": "ok" },
  "scratch_git": {
    "status": "ok",
    "url": "http://192.168.x.x:3100",
    "build_version": "26.04.17.21.28.96117875"
  },
  "scratch_git_http": {
    "status": "ok",
    "url": "http://192.168.x.x:3101",
    "build_version": "26.04.17.21.28.96117875"
  }
}
```

If either scratch-git entry is not `ok`, or the request times out, treat scratch-git as unhealthy from the API’s perspective.

### 3. Check memory on the compute instance (Metrics)

In **Compute Engine** → **VM instances** → select **`scratch-git`** → **Observability** / **Monitoring** (or open **Metrics explorer** and scope to this instance).

Review **memory utilization** and related charts over the incident window. A sharp spike followed by flatlined or missing Ops Agent metrics can indicate the host was under severe memory pressure or unresponsive (as in the 2026-04-17 incident).

### 4. Review logs in GCP (Logs Explorer)

In the GCP Console, open **Logging** → **Logs Explorer** for project `spv1eu-production`.

Useful starting filters:

- Container logs (labels applied by the instance startup script):

  ```
  labels.service="scratch-git"
  ```

- Proxy container:

  ```
  labels.service="scratch-git-proxy"
  ```

Adjust time range to the incident window. Look for OOM-related behavior, repeated errors, or absence of new log lines (possible hang).

### 5. Connect with SSH (`gcloud`)

Try to reach the instance over IAP:

```bash
gcloud compute ssh scratch-git \
  --project=spv1eu-production \
  --zone=europe-west1-b \
  --tunnel-through-iap
```

If SSH hangs or fails while the service-check and metrics suggest the host is unhealthy, that aligns with a frozen or overloaded VM; proceed to **Remediation** rather than waiting indefinitely.

## Remediation: Restart the `scratch-git` VM

Restarting clears a hung kernel/userspace state. It is the primary recovery step used in production when the instance is unrecoverable over SSH.

**Caution:** This causes a **full outage** of scratch-git until the instance boots, Docker starts, and containers are healthy—typically a few minutes. Coordinate with anyone running long pull/publish jobs if possible.

### Option A: GCP Console

1. Open [Compute Engine → VM instances](https://console.cloud.google.com/compute/instances?project=spv1eu-production) and select **`scratch-git`** (zone `europe-west1-b`).
2. Click **Stop** and wait until the instance is fully stopped.
3. Click **Start** / **Resume** to start the instance again.

Deep link to the instance detail page (same pattern as the postmortem):

[VM instance `scratch-git` — europe-west1-b](https://console.cloud.google.com/compute/instancesDetail/zones/europe-west1-b/instances/scratch-git?project=spv1eu-production)

### Option B: `gcloud` (Compute Engine API)

Equivalent to the console stop/start:

```bash
gcloud compute instances stop scratch-git \
  --project=spv1eu-production \
  --zone=europe-west1-b
```

Wait until the instance status is `TERMINATED`, then:

```bash
gcloud compute instances start scratch-git \
  --project=spv1eu-production \
  --zone=europe-west1-b
```

These commands use the [Compute Engine instances API](https://cloud.google.com/compute/docs/reference/rest/v1/instances) (`stop` / `start`).

On boot, the instance runs its startup script: it mounts the data disk, ensures Docker, pulls the configured image, starts **blue/green** scratch-git containers and the **nginx** proxy, and starts the Ops Agent. Allow several minutes before expecting a clean `service-check`.

## Confirm recovery

### 1. Repeat investigation checks

- Reload [https://api.scratch.md/service-check](https://api.scratch.md/service-check) until `scratch_git` and `scratch_git_http` are `ok` and versions look reasonable.
- Spot-check [https://app.scratch.md](https://app.scratch.md) and git-backed actions.

### 2. SSH and verify Docker

SSH in (same command as above). Docker commands require `sudo` when using OS Login with a service account user:

```bash
sudo docker ps
```

Confirm:

1. **`scratch-git-proxy`** is running (nginx on ports 3100/3101).
2. At least one application container is running: **`scratch-git-blue`** or **`scratch-git-green`** (blue/green deploy slots; both may be present; traffic follows the active slot via nginx).

Narrow the list:

```bash
sudo docker ps --filter name=scratch-git-proxy
sudo docker ps --filter name=scratch-git-blue
sudo docker ps --filter name=scratch-git-green
```

Optional: see which slot is active:

```bash
cat /mnt/disks/data/.active-slot
```

Optional: quick health from the host (if `curl` is available):

```bash
curl -sS http://127.0.0.1:3100/health 2>/dev/null || curl -sS http://127.0.0.1:3100/
```

### 3. Pipeline / deploy follow-up

If a production deploy failed while scratch-git was down, rerun the failed **scratch-git** deploy job after the VM is healthy so production runs the intended image version. See [scratch-git-2 docs — Deployment](../../scratch-git-2/docs/README.md) for SSH and startup-script details.

## Related documentation

- [Postmortem (2026-04-17)](postmortems/2026-04-17-scratch-git-unresponsive-prod-outage.md)
- [scratch-git-2 — Docker & GCP logging](../../scratch-git-2/docs/README.md)
- [Runbook: Recover an Individual Repo from a Scratch-Git Snapshot](runbook-scratch-git-repo-recovery.md)
