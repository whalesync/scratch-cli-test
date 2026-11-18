# Runbook: Roll Out a scratch-git Startup Script Change

How to get a merged change to the scratch-git VM's boot scripts onto the running VMs. The scripts are
[`startup.sh`](../../terraform/modules/scratch_git_gce/scripts/startup.sh), which runs on every boot, and
[`deploy.sh`](../../terraform/modules/scratch_git_gce/scripts/deploy.sh), which `startup.sh` writes to the data disk
for the CI deploy to run.

## Context

| Item | Value |
| --- | --- |
| GCP projects | `spv1eu-test`, then `spv1eu-production` |
| Instance | `scratch-git` (zone `europe-west1-b`) |
| Tool | [`terraform/tools/update_scratch_git_startup_script.sh`](../../terraform/tools/update_scratch_git_startup_script.sh) |
| Terraform | [`terraform/modules/scratch_git_gce/main.tf`](../../terraform/modules/scratch_git_gce/main.tf) — `metadata_startup_script` |

## Why a merge isn't enough

Terraform inlines both scripts into the VM's `startup-script` metadata. Changing that value in place would destroy and
recreate the VM, so `main.tf` ignores later changes to it (`lifecycle.ignore_changes`). A merged edit therefore only
reaches a VM that Terraform creates from scratch, and `terraform apply` shows no change for it.

On the VM, `sudo google_metadata_script_runner startup` doesn't help either: it reruns the copy in the metadata, which
is still the old one.

## Procedure

`update_scratch_git_startup_script.sh` reads the VM's current metadata and keeps the Terraform-injected variables at its
top. It replaces the embedded `deploy.sh` and `startup.sh` with the repo's copies, laid out exactly as Terraform renders
them, and prints the diff. With `--apply` it writes the result after you type the environment's name. It only changes
the metadata: the VM keeps running, no container restarts, and the new script runs at the VM's **next boot**.

Run it from an up-to-date `master` checkout.

### Test

1. Show what would change. Any account can run this, including the read-only ones:

   ```bash
   terraform/tools/update_scratch_git_startup_script.sh test
   ```

   The diff should show only the merged change. If it shows more, someone changed the scripts or the metadata
   without rolling it out; find out what before going on.

2. Apply it, as an account that can set the VM's metadata (not a `*-readonly@` one):

   ```bash
   terraform/tools/update_scratch_git_startup_script.sh test --apply
   ```

3. Boot the VM. In test, pause and wake it: run the manual pipeline on `master` with `TEST_POWER=pause`, then with
   `TEST_POWER=wake` (see [Pause test overnight](plans/2026-11-16-pause-test-overnight.md)). The wake waits for the
   startup script and fails if it logs a failure.

4. Check the result:
   - the wake job's log says "The startup script finished, and no failure was logged";
   - `terraform/tools/test_power.sh status` shows `api /service-check  ok (...)`;
   - anything specific to the change. For the 2026-11-18 change below, `sudo gitops-ps` through
     `terraform/tools/connect_to_git_service_ssh.sh test` lists one scratch-git container plus the proxy.

5. Run the tool again without `--apply`. It should say the VM already matches the repo.

### Production

`spv1eu-production` is protected: get an explicit go-ahead before step 2.

1. `terraform/tools/update_scratch_git_startup_script.sh production`, and check that the diff matches test's.
2. `terraform/tools/update_scratch_git_startup_script.sh production --apply`, as a `role_operations@` account.
3. The new script runs at production's next boot. Don't reboot production just for this unless the change needs it
   now; if it does, plan a maintenance window
   ([runbook-maintenance-mode.md](runbook-maintenance-mode.md)), because a boot restarts scratch-git.

### Applying a change before the next boot

The metadata only matters at boot. When a change has to take effect without a reboot (for example, the
`gitops-*` wrappers, DEV-10366), run the change's own self-contained block as root on the VM through a break-glass
`role_operations@` SSH session, as well as updating the metadata, so the next boot keeps it.

## Rollback

Check out the previous version of the scripts, run the tool with `--apply` again, and boot the VM. Anything the newer
script left on the VM's boot disk stays there unless the older script removes it. For the 2026-11-18 change, the
`/etc/fstab` line and the Docker drop-in stay. Both are harmless: the disk is mounted the same way, and Docker only waits
for it.

## Changes rolled out this way

| Merged | Change | Test | Production |
| --- | --- | --- | --- |
| 2026-11-18 | DEV-12906: mount the data disk from `/etc/fstab` and make `docker.service` require it, so a boot never starts the containers before the disk is mounted; start only the active slot, not both blue and green | Not yet | Not yet |

**About the 2026-11-18 change:**

- The first boot that runs it still has the old race once: the script writes the `/etc/fstab` line and the drop-in
  during that boot, so only later boots are protected.
- After it, if the data disk is missing at boot, Docker doesn't start, and the startup script fails when it can't mount
  the disk. Before, the containers started against an empty `/data`.
