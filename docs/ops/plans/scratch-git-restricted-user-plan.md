# Scratch Git: Restricted Read-Only VM Access

| | |
| --- | --- |
| **Created** | 2026-06-10 |
| **Author** | Chris Hoefgen |
| **Status** | Proposed |
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

1. **IAM decides the landing tier.** A new low-privilege Google group is granted only `roles/compute.osLogin` (note: **not** `osAdminLogin`). Such a principal lands as a **non-sudo** OS Login user, not in the `docker` group — they can't talk to the Docker socket or `sudo` anything by default.
2. **A tightly-scoped `sudoers` allowlist of root-owned wrapper scripts** grants exactly four read-only inspection commands. This is necessary because raw Docker access is root-equivalent (`docker run -v /:/host …` escapes to host root), so we can neither add the user to the `docker` group nor allow `sudo docker`. The wrappers only ever run read-only `docker`/`git` subcommands with validated arguments.

No VM metadata change and no change to the existing OS Login / IAP / firewall setup is required.

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
   │  │ role_git_operators         │  │ role_operations        │ │
   │  │ roles/compute.osLogin      │  │ roles/compute.admin +  │ │
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
   │   /opt/gitops/bin/*  (root:root 0755)                        │
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
2. **Strictly read-only.** The restricted tier can only *inspect*. Docker cleanup and disk-space *fixes* (the mutating items originally listed on the ticket) stay break-glass. Disk-usage *reporting* is included because it is read-only.
3. **Additive only.** This adds the restricted tier and makes it the documented entry point; it does **not** remove or downgrade `role_operations`' existing root access, which remains the break-glass path. Forcing routine access off root entirely is a larger IAM change left for a follow-up.
4. **Wrappers + `sudoers`, not docker-group or `sudo docker *`.** Docker socket access is root. A `sudoers` wildcard (`sudo docker logs *`) is flag-injection fragile and can't constrain the subcommand surface. Root-owned wrappers with validated, allowlisted arguments keep the command surface minimal and auditable.

## Implementation

### 1. VM tooling — `terraform/modules/scratch_git_gce/scripts/startup.sh`

Append one **idempotent, self-contained** block (safe to re-run, and hand-runnable as break-glass) after the containers start. It installs four wrappers under `/opt/gitops/bin/` as `root:root` mode `0755` and a validated `sudoers` drop-in. Validate the sudoers file with `visudo -cf` before installing it.

```bash
# ---------- restricted read-only ops tooling (DEV-10366) ----------
install -o root -g root -m 0755 -d /opt/gitops/bin

# gitops-ps — docker state (no user args)
cat > /opt/gitops/bin/gitops-ps <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
echo "=== docker ps -a ==="; /usr/bin/docker ps -a
echo; echo "=== docker stats (snapshot) ==="; /usr/bin/docker stats --no-stream
WRAP

# gitops-logs <scratch-git-blue|green|proxy> [lines]
cat > /opt/gitops/bin/gitops-logs <<'WRAP'
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
cat > /opt/gitops/bin/gitops-disk <<'WRAP'
#!/usr/bin/env bash
set -euo pipefail
echo "=== df -h ==="; df -h
echo; echo "=== docker system df ==="; /usr/bin/docker system df
echo; echo "=== du /mnt/disks/data (top 40) ==="
du -xh --max-depth=2 /mnt/disks/data 2>/dev/null | sort -h | tail -40
WRAP

# gitops-git <org_../wkb_../coa_..> <read-only-subcommand> [args...]
cat > /opt/gitops/bin/gitops-git <<'WRAP'
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

chmod 0755 /opt/gitops/bin/gitops-*

# sudoers: only the four wrappers, NOPASSWD. Granting to ALL is safe — the
# command surface is four read-only wrappers; the real gate is IAM (who gets
# osLogin + IAP at all). Admins keep their separate google-sudoers root grant.
cat > /tmp/gitops.sudoers <<'SUDO'
Cmnd_Alias GITOPS_RO = /opt/gitops/bin/gitops-ps, /opt/gitops/bin/gitops-logs, \
                       /opt/gitops/bin/gitops-disk, /opt/gitops/bin/gitops-git
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

Add a low-privilege role set and bind it to a new group. This reuses the existing `principals_to_roles` → `flatten` → `google_project_iam_member.roles` machinery, so **no new resource type** is needed:

```hcl
# Restricted, read-only access to the scratch-git VM (DEV-10366).
git_operator_roles = [
  "roles/compute.osLogin",            # SSH in as a NON-admin (no sudo) OS Login user
  "roles/iap.tunnelResourceAccessor", # reach the VM through the IAP TCP tunnel
  "roles/logging.viewer",             # read container logs in Logs Explorer (gcplogs)
  "roles/compute.viewer",             # see the instance (read-only)
]
```

```hcl
principals_to_roles = {
  "group:role_operations@whalesync.com" : [local.terraform_roles, local.operations_roles],
  "group:role_developers@whalesync.com" : local.developer_roles,
  "group:role_git_operators@whalesync.com" : local.git_operator_roles,  # NEW
}
```

**Non-Terraform prerequisite:** create the Google Workspace group `role_git_operators@whalesync.com` at the org level (the same way the existing two `whalesync.com` groups are managed) and add the intended members — including any agent identity that should have restricted VM access. `role_operations` is left untouched as the break-glass admin path.

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

The IAM module is shared, so the group binding lands in every env that instantiates it. Roll out to **test first**, verify, then production.

**Startup-script activation caveat:** editing `metadata_startup_script` updates instance metadata but does **not** re-run on a live instance — the wrappers/`sudoers` appear on the next boot. To activate without waiting for a reboot, re-run the startup script in place (the same mechanism the deploy job uses):

```bash
# on the VM, as an admin (break-glass)
sudo google_metadata_script_runner startup
```

Because the install block is idempotent and self-contained, an admin can alternatively paste just that block to activate it with zero container disruption. Note `replace_triggered_by` only fires on data-disk id change and `metadata["ssh-keys"]` is ignored, so a `terraform apply` causes **no disk replacement** — confirm in the plan output.

**Suggested sequence:**

1. Merge the Terraform + script + docs changes; create the `role_git_operators@whalesync.com` group and add members.
2. `terraform apply` in `eu-test`; expect only new `google_project_iam_member.roles[…]` entries and an update to `scratch_git`'s `metadata_startup_script` (no disk replacement).
3. Activate on the test VM (`google_metadata_script_runner startup` or run the block by hand); verify (below).
4. Repeat for `eu-production`.

## Out of scope / break-glass

Cleanup (`docker … prune`, `journalctl --vacuum`), disk-space fixes, deleting any file, `docker exec/run/cp/inspect`, and repo writes are **not** in the restricted tier. They remain available to `role_operations` admins via the existing `gcloud compute ssh … --tunnel-through-iap` → root path, which the full-disk-restore and repo-recovery runbooks already assume.

## Verification

**Static / local:**

- `terraform fmt -check` + `terraform validate` in `terraform/envs/eu-test` and `eu-production`.
- `terraform plan` (eu-test): only new IAM members + a `metadata_startup_script` update; **no disk replacement**.
- `shellcheck` the four wrappers, the modified `startup.sh` (keep its `# shellcheck shell=bash disable=SC1091` header), and `connect_to_git_service_ssh.sh`; `visudo -cf` a local copy of the sudoers file.

**On-VM (test first), as a `role_git_operators` (osLogin-only) identity:**

1. `sudo -l` lists **only** the four `/opt/gitops/bin/gitops-*` commands (NOPASSWD).
2. Capabilities work: `sudo gitops-ps`; `sudo gitops-logs scratch-git-proxy 50`; `sudo gitops-disk`; `sudo gitops-git org_…/wkb_…/coa_… log -n 5`.
3. Denials all fail: `docker ps` (socket denied — not in docker group); `sudo docker ps` (not in sudoers); `sudo rm -rf /mnt/disks/data`; `sudo gitops-logs evil 10` (name allowlist); `sudo gitops-git ../../etc/passwd log` (path containment); `sudo gitops-git org_…/… push` (write subcommand).
4. As a `role_operations` (osAdminLogin) identity: confirm break-glass still works — `sudo docker ps`, `sudo docker exec …`, manual `rm` all succeed.
5. `connect_to_git_service.sh test` still port-forwards 3100 (unchanged).

## Open questions

- **Group vs. existing identities.** This plan creates a dedicated `role_git_operators@whalesync.com`. An alternative is to grant `git_operator_roles` to the existing `role_developers@whalesync.com` (who currently can't SSH at all), avoiding a new group at the cost of widening who can reach the prod VM. Confirm which is preferred.
- **Logging viewer scope.** `roles/logging.viewer` is project-wide read of logs. If that is broader than desired for this tier, drop it and rely on the on-VM `gitops-logs` wrapper for container logs.
- **Closing the default footgun.** This issue is additive and does not move routine access off root. A follow-up could downgrade `role_operations`' default OS Login to non-admin with a separate break-glass admin group — the higher-impact safety change deferred here.
