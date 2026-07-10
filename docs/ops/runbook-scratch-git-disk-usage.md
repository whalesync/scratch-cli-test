# Runbook: scratch-git Disk Usage High

Guide for the **`scratch_git_disk_usage_too_high`** alert — the production **`scratch-git`** GCE VM's
data disk crossed the **80%** warning threshold (posts to Slack **`#feed-gcp-alerts`** for
`spv1eu-production`). The goal is to find what is consuming the disk and free or grow it **before** it
fills: a full data disk wedges git operations and takes scratch-git down.

This is the "disk is filling up" runbook. For a disk that is already **corrupted or unusable**, see
[Full Scratch-Git Disk Restore from Snapshot](runbook-scratch-git-full-disk-restore.md); to recover a
single repo, see [Recover an Individual Repo](runbook-scratch-git-repo-recovery.md).

## Context

| Item | Value |
| --- | --- |
| GCP project | `spv1eu-production` |
| Instance | `scratch-git` (zone `europe-west1-b`) |
| Data disk | mounted at `/mnt/disks/data` — git repos + Docker |
| Slack channel | `#feed-gcp-alerts` |
| Alert definition | [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf) — `scratch_git_disk_usage_too_high` |
| Read-only SSH | [`terraform/tools/connect_to_git_service_ssh.sh`](../../terraform/tools/connect_to_git_service_ssh.sh) `production` → `gitops-*` wrappers |

## Investigation

### 1. See what is using the disk (read-only)

The per-dev read-only SA lands in the restricted tier and may run the `gitops-*` wrappers:

```bash
terraform/tools/connect_to_git_service_ssh.sh production
# then, on the VM:
sudo gitops-disk        # df -h + docker system df + du of the data disk
```

Attribute the usage: **git repos** under the data mount, **Docker** images/layers/build cache, or
**log** growth. Note whether it is a steady climb (organic growth → grow the disk) or a sudden jump
(a runaway job, a stuck container, or accumulated dangling images → reclaim).

### 2. Check the usual culprits

- Dangling / old Docker images and build cache (blue/green deploys leave prior images).
- Large or orphaned repos (a workbook deleted in the app but not on disk).
- Log files that are not rotating.

## Remediation

- **Reclaim space (cleanup)** — `docker system prune`, removing orphaned repos, or rotating logs is a
  **mutation** and therefore **break-glass**: the read-only wrappers cannot do it. Escalate to a
  `role_operations@whalesync.com` admin for a root SSH (per [`docs/ops/CLAUDE.md`](CLAUDE.md) and the
  helper's header notes). Do not attempt cleanup from a read-only session.
- **Grow the disk (durable)** — increase the persistent disk size in Terraform (`modules/env`) and
  open an MR; hand the apply to the deploy owner. Prefer this over repeated manual cleanup if the disk
  is simply growing with usage.
- **If the disk is already full and scratch-git is unhealthy** — follow
  [Unresponsive scratch-git Server](runbook-scratch-git-unresponsive-production.md) (restart) and, if
  the filesystem is damaged, [Full Scratch-Git Disk Restore](runbook-scratch-git-full-disk-restore.md).

## Related

- [Runbook: Unresponsive scratch-git Server](runbook-scratch-git-unresponsive-production.md)
- [Runbook: Full Scratch-Git Disk Restore from Snapshot](runbook-scratch-git-full-disk-restore.md)
- [Runbook: Recover an Individual Repo from a Scratch-Git Snapshot](runbook-scratch-git-repo-recovery.md)
- Alert definitions: [`terraform/modules/env/monitoring.tf`](../../terraform/modules/env/monitoring.tf)
