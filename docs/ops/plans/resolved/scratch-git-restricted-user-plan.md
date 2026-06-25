# Scratch Git: Restricted Read-Only VM Access

| | |
| --- | --- |
| **Created** | 2026-06-10 |
| **Author** | Chris Hoefgen |
| **Status** | Resolved |
| **Resolved** | 2026-06-25 — applied + validated end-to-end in `spv1eu-test` and `spv1eu-production` |
| **Linear** | [DEV-10366](https://linear.app/whalesync/issue/DEV-10366/define-a-restricted-user-for-scratch-git-vm-access) |
| **GCP projects** | `spv1eu-test`, `spv1eu-production` |
| **Origin** | Agent + Workstation Safety meeting (2026-06-09) |

## Problem

The `scratch-git` GCE VM stores **every user's git repository** on its persistent data disk (`/mnt/disks/data`). Today the only way to get a shell on it is as a member of `role_operations@whalesync.com`, who land as a **full root / sudo user**:

- `terraform_roles` grants `roles/compute.osAdminLogin` and `operations_roles` grants `roles/compute.admin` (which also includes admin OS Login). Google's OS Login guest agent puts `osAdminLogin` principals into the `google-sudoers` group, so they get an unrestricted `sudo`. The unresponsive-production runbook even documents that `sudo docker ps` "just works."

That means anyone — or anything — holding an operator's `gcloud` credentials can `rm -rf /mnt/disks/data`, `docker rm -f` the containers, or otherwise destroy production data with a single command. The **Agent + Workstation Safety** review (2026-06-09) flagged this: an AI agent running on an operator's workstation inherits those credentials and that blast radius. There is currently **no lower-privilege way** to simply *look at* the box.

## Approach

Add a **restricted, read-only access tier** that lets an operator (or an agent) SSH in and inspect the machine — view Docker state and logs, read disk-usage reports, and read git repos — **without any ability to mutate**. The existing full-root path is retained, unchanged, as an explicit break-glass tier for the rare cases that genuinely need it (cleanup, disk-space fixes, recovery).

The restricted tier is built from two independent pieces:

1. **IAM decides the landing tier.** The existing read-only identity — `role_readonly_sa@whalesync.com`, the per-dev "gcp-ro" service accounts that a developer laptop or AI agent already authenticates as by default (DEV-10397/DEV-10401) — is granted **instance-scoped** `roles/compute.osLogin` on the scratch-git VM (note: **not** `osAdminLogin`). Such a principal lands as a **non-sudo** OS Login user, not in the `docker` group — they can't talk to the Docker socket or `sudo` anything by default. Because OS Login into a VM with an attached service account also requires `roles/iam.serviceAccountUser` (`actAs`) on that SA, the group is granted `actAs` on `scratch-git-service-account` too — exactly the trio the Cloud SQL bastion already uses for read-only DB inspection.
2. **A tightly-scoped `sudoers` allowlist of root-owned wrapper scripts** grants exactly four read-only inspection commands. This is necessary because raw Docker access is root-equivalent (`docker run -v /:/host …` escapes to host root), so we can neither add the user to the `docker` group nor allow `sudo docker`. The wrappers only ever run read-only `docker`/`git` subcommands with validated arguments.

No VM metadata change and no change to the existing OS Login / IAP / firewall setup is required.

> **Why the existing gcp-ro group, not a new one.** The whole point of the ticket (Agent + Workstation Safety) is that an AI agent on a dev's workstation must be able to *look at* the box read-only. That agent runs as the `gcp-ro` read-only SA. Granting the restricted tier to a brand-new `role_git_operators@` group would not reach that SA, so the access would not work for the identity it exists to serve. Reusing `role_readonly_sa@` mirrors the Cloud SQL read-only DB tier these SAs already have, needs no new Workspace group, and keeps "read-only by default for laptops + agents" coherent across the DB and the git VM.

## Architecture

```
  Operator / Agent workstation (gcloud + IAP)
                  │
                  │  gcloud compute ssh scratch-git --tunnel-through-iap
                  ▼
        ┌───────────────────┐
        │  GCP IAP tunnel    │   (tcp/22 from 35.235.240.0/20 — already allowed)
        └─────────┬─────────┘
                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │  scratch-git VM  (OS Login enabled)                          │
   │                                                              │
   │  Landing tier is chosen by the caller's IAM role:            │
   │                                                              │
   │  ┌────────────────────────────┐  ┌────────────────────────┐ │
   │  │ RESTRICTED                 │  │ BREAK-GLASS (unchanged)│ │
   │  │ role_readonly_sa@ (gcp-ro) │  │ role_operations        │ │
   │  │ compute.osLogin (instance) │  │ roles/compute.admin +  │ │
   │  │ (NO osAdminLogin)          │  │ osAdminLogin           │ │
   │  │ → non-sudo user            │  │ → google-sudoers root  │ │
   │  │ → NOT in docker group      │  │ → full root            │ │
   │  │                            │  │                        │ │
   │  │ may ONLY run:              │  │ may run anything       │ │
   │  │  sudo gitops-ps            │  │  sudo docker …         │ │
   │  │  sudo gitops-logs <c> [n]  │  │  rm, prune, exec, …    │ │
   │  │  sudo gitops-disk          │  │                        │ │
   │  │  sudo gitops-git <id> <ro> │  │                        │ │
   │  └────────────────────────────┘  └────────────────────────┘ │
   │                                                              │
   │   /usr/local/sbin/*  (root:root 0755)                        │
   │   /etc/sudoers.d/gitops  (NOPASSWD, the 4 wrappers only)     │
   │                                                              │
   │   /mnt/disks/data  ── all user repos (read via gitops-git)   │
   │   docker: scratch-git-blue / -green / -proxy                 │
   └──────────────────────────────────────────────────────────────┘
```

### Restricted-tier capabilities

| Need | Wrapper | What it runs (read-only) |
| --- | --- | --- |
| View docker logs | `gitops-logs <container> [lines]` | `docker logs --tail N` for the three known containers only |
| View docker state | `gitops-ps` | `docker ps -a`, `docker stats --no-stream` |
| Inspect disk usage | `gitops-disk` | `df -h`, `docker system df`, `du` on `/mnt/disks/data` |
| Inspect a repo | `gitops-git <repo_id> <subcommand> [args]` | read-only `git` (`log/show/diff/status/cat-file/…`) on one repo |

**Deliberately excluded** (root-equivalent, secret-leaking, or mutating — all break-glass): `docker exec/run/cp/commit/build/inspect`, any `rm`, any `prune`/`vacuum`, and any git write (`push/commit/gc/fetch/config`).

## Key decisions

1. **Non-admin OS Login tier, not a shared local user.** Access is gated by the caller's own Google identity (`roles/compute.osLogin`), preserving per-person Cloud Audit logs and avoiding a shared SSH key to store and rotate. (The alternative — a fixed `gitops` local user with a key in Secret Manager, mirroring `connect_to_gcp_db_readonly.sh` — was rejected for weaker auditability and more moving parts.)
2. **Grant to the existing `role_readonly_sa@` (gcp-ro), not a new group.** The identity that actually needs this — an agent/laptop — already runs as the read-only `gcp-ro` SA. Reusing that group is what makes the access *work for the intended caller*, and it mirrors the read-only DB-bastion tier these SAs already hold. The grants are **instance-scoped** (`google_compute_instance_iam_member` + `google_iap_tunnel_instance_iam_member` on the scratch-git VM only) plus narrow `actAs` on the one attached SA — never project-wide osLogin/IAP — so reusing this broad group does not widen its reach beyond this single VM.
3. **Strictly read-only.** The restricted tier can only *inspect*. Docker cleanup and disk-space *fixes* (the mutating items originally listed on the ticket) stay break-glass. Disk-usage *reporting* is included because it is read-only.
4. **Additive only.** This adds the restricted tier and makes it the documented entry point; it does **not** remove or downgrade `role_operations`' existing root access, which remains the break-glass path. Forcing routine access off root entirely is a larger IAM change left for a follow-up.
5. **Wrappers + `sudoers`, not docker-group or `sudo docker *`.** Docker socket access is root. A `sudoers` wildcard (`sudo docker logs *`) is flag-injection fragile and can't constrain the subcommand surface. Root-owned wrappers with validated, allowlisted arguments keep the command surface minimal and auditable. The `sudoers` rule grants the four wrappers to `ALL` users specifically because a service account's OS Login username isn't known ahead of time; the real gate stays IAM (who gets osLogin + IAP).

## Implementation

### 1. VM tooling — `terraform/modules/scratch_git_gce/scripts/startup.sh`

Append one **idempotent, self-contained** block (safe to re-run, and hand-runnable as break-glass) after the containers start. It installs four wrappers under `/usr/local/sbin/` as `root:root` mode `0755` and a validated `sudoers` drop-in. Validate the sudoers file with `visudo -cf` before installing it.

> **Install location matters — use `/usr/local/sbin`, not a dedicated dir.** `/usr/local/sbin` is already on sudo's default `secure_path`, so a bare `sudo gitops-ps` resolves to the allowed path and matches the NOPASSWD rule. An earlier iteration installed to `/opt/gitops/bin` (not on `secure_path`); there, bare `sudo gitops-ps` couldn't be resolved to the allowlisted full path, so sudo fell through to a password prompt (which a service account has no password for) — caught during eu-test validation, 2026-06-25.

> **Required companion change — `scratch_git_gce/main.tf` lifecycle.** Because `metadata_startup_script` is ForceNew (see [Activation & rollout](#activation--rollout)), this `startup.sh` edit must be paired with adding `metadata_startup_script` to the instance's `lifecycle.ignore_changes` — otherwise `terraform apply` replaces the VM. Without it the change is destructive; with it the plan is non-destructive.

```bash
# ---------- restricted read-only ops tooling (DEV-10366) ----------
# /usr/local/sbin already exists and is on secure_path; clean up any wrappers
# left in the earlier /opt/gitops/bin location (not on secure_path).
rm -f /opt/gitops/bin/gitops-* 2>/dev/null || true; rmdir /opt/gitops/bin 2>/dev/null || true

# gitops-ps — docker state (no user args)
cat > /usr/local/sbin/gitops-ps <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
echo "=== docker ps -a ==="; /usr/bin/docker ps -a
echo; echo "=== docker stats (snapshot) ==="; /usr/bin/docker stats --no-stream
WRAP

# gitops-logs <scratch-git-blue|green|proxy> [lines]
cat > /usr/local/sbin/gitops-logs <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
container="${1:-}"; lines="${2:-200}"
case "$container" in
  scratch-git-blue|scratch-git-green|scratch-git-proxy) ;;
  *) echo "error: container must be scratch-git-{blue,green,proxy}" >&2; exit 2 ;;
esac
[[ "$lines" =~ ^[0-9]{1,5}$ ]] || { echo "error: lines must be numeric" >&2; exit 2; }
exec /usr/bin/docker logs --tail "$lines" -- "$container"
WRAP

# gitops-disk — read-only disk report (fixed paths)
cat > /usr/local/sbin/gitops-disk <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
echo "=== df -h ==="; df -h
echo; echo "=== docker system df ==="; /usr/bin/docker system df
echo; echo "=== du /mnt/disks/data (top 40) ==="
du -xh --max-depth=2 /mnt/disks/data 2>/dev/null | sort -h | tail -40
WRAP

# gitops-git <org_../wkb_../coa_..> <read-only-subcommand> [args...]
cat > /usr/local/sbin/gitops-git <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
export GIT_PAGER=cat PAGER=cat
REPO_ROOT=/mnt/disks/data/repos
repo_id="${1:-}"; sub="${2:-}"; shift 2 2>/dev/null || { echo "usage: gitops-git <repo_id> <subcommand> [args]" >&2; exit 2; }
[[ "$repo_id" =~ ^org_[A-Za-z0-9]+/wkb_[A-Za-z0-9]+/coa_[A-Za-z0-9]+$ ]] \
  || { echo "error: repo id must be org_.../wkb_.../coa_..." >&2; exit 2; }
real="$(readlink -f -- "$REPO_ROOT/$repo_id.git" 2>/dev/null || true)"
case "$real" in "$REPO_ROOT"/*.git) ;; *) echo "error: path escapes $REPO_ROOT" >&2; exit 2 ;; esac
[ -d "$real" ] || { echo "error: repo not found: $repo_id" >&2; exit 2; }
case "$sub" in
  log|show|diff|status|ls-files|ls-tree|cat-file|rev-parse|rev-list|for-each-ref|show-ref|count-objects|fsck|shortlog|describe) ;;
  *) echo "error: subcommand '$sub' not allowed (read-only only)" >&2; exit 2 ;;
esac
for a in "$@"; do case "$a" in
  -o|--output|--output=*|--output-directory=*|--ext-diff|--upload-pack=*|--exec=*|--exec-path=*)
    echo "error: flag '$a' not allowed" >&2; exit 2 ;;
esac; done
exec /usr/bin/git --no-pager -C "$real" "$sub" "$@"
WRAP

chmod 0755 /usr/local/sbin/gitops-ps /usr/local/sbin/gitops-logs /usr/local/sbin/gitops-disk /usr/local/sbin/gitops-git

# sudoers: only the four wrappers, NOPASSWD. Granting to ALL is safe — the
# command surface is four read-only wrappers; the real gate is IAM (who gets
# osLogin + IAP at all). Admins keep their separate google-sudoers root grant.
cat > /tmp/gitops.sudoers <<'SUDO'
Cmnd_Alias GITOPS_RO = /usr/local/sbin/gitops-ps, /usr/local/sbin/gitops-logs, \
                       /usr/local/sbin/gitops-disk, /usr/local/sbin/gitops-git
Defaults!GITOPS_RO env_reset, !requiretty, secure_path="/usr/sbin:/usr/bin:/sbin:/bin"
ALL ALL=(root) NOPASSWD: GITOPS_RO
SUDO
visudo -cf /tmp/gitops.sudoers && install -o root -g root -m 0440 /tmp/gitops.sudoers /etc/sudoers.d/gitops
rm -f /tmp/gitops.sudoers
# ---------- end restricted read-only ops tooling ----------
```

Core safety properties: wrappers are root-owned (caller can't edit them) and hard-code absolute `/usr/bin/docker` and `/usr/bin/git` with `env_reset`/`secure_path` (no `$PATH` shadowing); the `sudoers` line carries **no wildcards** (all argument policy lives in the wrappers); container names and repo IDs are allowlist/regex-validated; the repo path is canonicalized and contained under `/mnt/disks/data/repos`; `git` runs `--no-pager` (no pager `!sh` escape) with a read-only subcommand allowlist.

> The snapshot-recovery VM in `runbook-scratch-git-repo-recovery.md` uses its own inline startup script and is admin-only/temporary — intentionally out of scope.

### 2. IAM — `terraform/modules/env/main.tf`

Grant the restricted tier to the **existing** `role_readonly_sa@whalesync.com` (gcp-ro) group, mirroring the Cloud SQL bastion block already in this file. Two **instance-scoped** bindings on the scratch-git VM, plus `actAs` on its attached service account. No new role list and **no new Workspace group**:

```hcl
# Instance-scoped: SSH in as a NON-admin (no sudo) OS Login user, through the IAP TCP tunnel.
resource "google_iap_tunnel_instance_iam_member" "readonly_sa_scratch_git_tunnel" {
  count    = var.enable_scratch_git ? 1 : 0
  project  = var.gcp_project_id
  zone     = var.gcp_zone
  instance = module.scratch_git_gce[0].instance_name
  role     = "roles/iap.tunnelResourceAccessor"
  member   = "group:role_readonly_sa@whalesync.com"
}

resource "google_compute_instance_iam_member" "readonly_sa_scratch_git_oslogin" {
  count         = var.enable_scratch_git ? 1 : 0
  project       = var.gcp_project_id
  zone          = var.gcp_zone
  instance_name = module.scratch_git_gce[0].instance_name
  role          = "roles/compute.osLogin"
  member        = "group:role_readonly_sa@whalesync.com"
}
```

The **third, essential** piece is `actAs` on the attached SA — without it OS Login SSH fails with `Permission denied (publickey)`. Add it to the `scratch-git-service-account` entry in the `service_accounts` local (the module turns this into an authoritative `roles/iam.serviceAccountUser` binding):

```hcl
{
  name        = "scratch-git-service-account"
  # ...
  service_account_users = ["group:role_readonly_sa@whalesync.com"]  # NEW — actAs for OS Login SSH
  roles = ["roles/artifactregistry.reader", "roles/logging.logWriter", "roles/monitoring.metricWriter"]
}
```

`role_readonly_sa@` already holds project-wide `compute.viewer` + `logging.viewer` (see `readonly_sa_roles`), so it can already see the instance and read the gcplogs container logs — nothing to add there.

**No non-Terraform prerequisite.** The `role_readonly_sa@whalesync.com` group already exists and already contains the per-dev `<alias>-readonly` (gcp-ro) SAs (DEV-10397); members are managed in Workspace as today. `role_operations` is left untouched as the break-glass admin path.

### 3. Connect script — `terraform/tools/connect_to_git_service_ssh.sh` (new)

An interactive IAP SSH shell (no `-N -L` port forward), reusing the env-argument validation from the two sibling scripts:

```bash
gcloud compute ssh scratch-git --project "spv1eu-${ENVIRONMENT}" --zone europe-west1-b --tunnel-through-iap
```

It prints a short banner listing the four allowed `sudo gitops-*` commands. The command is identical for everyone — IAM decides the tier (osLogin → restricted, osAdminLogin → root). The existing `connect_to_git_service.sh` stays as the 3100 port-forward, untouched.

### 4. Documentation

- **`docs/ops/runbook-scratch-git-unresponsive-production.md`** — in "SSH and verify Docker", add the restricted path (`connect_to_git_service_ssh.sh production` → `sudo gitops-ps` / `sudo gitops-logs scratch-git-proxy 200`), keeping `sudo docker ps` under the admin/break-glass path.
- **`CLAUDE.md`** — add a bullet parallel to the existing "Inspecting a live database (read-only)" note: how to get a restricted scratch-git shell, the four allowed `sudo gitops-*` commands, and that any mutation/cleanup needs the `role_operations` break-glass path.
- **This plan** — moves to `docs/ops/plans/resolved/` once applied to production.

## Activation & rollout

The IAM bindings are instance-scoped and gated on `var.enable_scratch_git`, so they land in every env that actually provisions the scratch-git VM. Roll out to **test first**, verify, then production.

**Startup-script activation caveat — `metadata_startup_script` is ForceNew.** This is the one non-obvious hazard, confirmed by an actual refreshed `terraform plan` in eu-test: the google provider treats `metadata_startup_script` as ForceNew, so editing it (the script is inlined into it) would **destroy and recreate the scratch-git VM** — a full service outage (the data disk is a separate resource and survives the reattach, but the service does not). An early draft of this plan wrongly claimed apply would just update metadata with "no disk replacement"; the plan output instead showed `# google_compute_instance.scratch_git must be replaced`.

The fix is to add `metadata_startup_script` to the instance's `lifecycle.ignore_changes` (in `scratch_git_gce/main.tf`). With that in place, the refreshed plan drops to exactly the four IAM changes — **2 to add, 2 to change, 0 to destroy** — and the VM is never replaced. Because `ignore_changes` only suppresses *updates* (not create-time values), a freshly-built instance still bakes in the current `startup.sh`, so the wrappers stay durable across rebuilds.

The flip side: terraform no longer pushes startup-script edits to a *live* instance, so the wrappers must be activated out-of-band on the current VM (an admin / break-glass action):

```bash
# on the VM, as an admin (break-glass) — paste just the idempotent
# "restricted read-only ops tooling" block for zero container disruption,
# OR re-run the whole startup script (note: this also re-pulls the image
# and recreates the blue/green/proxy containers — a brief blip):
sudo google_metadata_script_runner startup
```

**Suggested sequence:**

1. Merge the Terraform + script + docs changes. No Workspace group to create — `role_readonly_sa@` already exists and already holds the gcp-ro SAs.
2. `terraform apply` in `eu-test`; confirm the plan is **2 to add, 2 to change, 0 to destroy** — the two instance-scoped IAM members (`google_compute_instance_iam_member` + `google_iap_tunnel_instance_iam_member`) and the two `scratch-git-service-account` binding updates (`serviceAccountUser` + the inert `serviceAccountTokenCreator`). **No instance replacement** (thanks to the `ignore_changes`); if you see `scratch_git must be replaced`, stop — the `ignore_changes` is missing.
3. Activate the wrappers on the test VM out-of-band (paste the block, or `google_metadata_script_runner startup`); verify (below).
4. Repeat for `eu-production`.

## Out of scope / break-glass

Cleanup (`docker … prune`, `journalctl --vacuum`), disk-space fixes, deleting any file, `docker exec/run/cp/inspect`, and repo writes are **not** in the restricted tier. They remain available to `role_operations` admins via the existing `gcloud compute ssh … --tunnel-through-iap` → root path, which the full-disk-restore and repo-recovery runbooks already assume.

## Verification

**Static / local:**

- `terraform fmt -check` + `terraform validate` in `terraform/envs/eu-test` and `eu-production`.
- `terraform plan` (eu-test): **2 to add, 2 to change, 0 to destroy** — the two instance-scoped IAM members + the two `scratch-git-service-account` binding updates. There must be **no `google_compute_instance.scratch_git must be replaced`**; if there is, the `metadata_startup_script` `ignore_changes` is missing (verified against a real refreshed plan in eu-test, 2026-06-24).
- `shellcheck` the four wrappers, the modified `startup.sh` (keep its `# shellcheck shell=bash disable=SC1091` header), and `connect_to_git_service_ssh.sh`; `visudo -cf` a local copy of the sudoers file.

**On-VM (test first), as a `role_readonly_sa@` "gcp-ro" (osLogin-only) identity** — i.e. authenticated as the read-only SA the laptop/agent uses by default (`gcp-ro` gcloud config). The critical check is that SSH **connects at all**: it only does once the `actAs` (`iam.serviceAccountUser`) grant on `scratch-git-service-account` lands — without it, expect `Permission denied (publickey)`.

1. SSH succeeds as the gcp-ro SA via `connect_to_git_service_ssh.sh test` (proves osLogin + IAP + actAs are all in place).
2. `sudo -l` lists **only** the four `/usr/local/sbin/gitops-*` commands (NOPASSWD).
3. Capabilities work: `sudo gitops-ps`; `sudo gitops-logs scratch-git-proxy 50`; `sudo gitops-disk`; `sudo gitops-git org_…/wkb_…/coa_… log -n 5`.
4. Denials all fail: `docker ps` (socket denied — not in docker group); `sudo docker ps` (not in sudoers); `sudo rm -rf /mnt/disks/data`; `sudo gitops-logs evil 10` (name allowlist); `sudo gitops-git ../../etc/passwd log` (path containment); `sudo gitops-git org_…/… push` (write subcommand).
5. As a `role_operations` (osAdminLogin) identity: confirm break-glass still works — `sudo docker ps`, `sudo docker exec …`, manual `rm` all succeed.
6. `connect_to_git_service.sh test` still port-forwards 3100 (unchanged).

## Open questions

- **Group vs. existing identities — resolved.** The restricted tier is granted to the existing `role_readonly_sa@whalesync.com` (gcp-ro) group, because the agent/laptop that needs to inspect the VM already runs as that read-only SA — granting a separate new group would not reach it. The grants are instance-scoped to the scratch-git VM only (plus narrow `actAs` on its one SA), so reusing this group does not widen its reach elsewhere. (The earlier draft created a dedicated `role_git_operators@`; that was dropped.)
- **Closing the default footgun.** This issue is additive and does not move routine access off root. A follow-up could downgrade `role_operations`' default OS Login to non-admin with a separate break-glass admin group — the higher-impact safety change deferred here.
