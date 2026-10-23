# Production GCS buckets → multi-region `EU` (Vanta redundant-backup test)

- **Created:** 2026-10-08
- **Author:** Chris Hoefgen (with Claude)
- **Linear:** [DEV-11918](https://linear.app/whalesync/issue/DEV-11918)
- **Status:** **Done on 2026-10-23.** All five prod buckets are in the `EU` multi-region, Terraform matches (MR !3419, `plan` clean), and the Vanta test passes. See [Production run](#production-run-2026-10-23). **One follow-up remains:** disable Storage Intelligence on `spv1eu-production` by **2026-11-17**. Its trial auto-upgrades to paid `STANDARD` on 2026-11-22 15:18 UTC (commands in [step 7](#7-close-out)).
- **GCP project:** `spv1eu-production` only. `spv1eu-test` is out of scope and keeps its single-region buckets.


## Problem statement

Vanta added the test [GCP Cloud Storage redundant backup](https://app.vanta.com/c/whalesync.com/tests/gcp-cloud-storage-redundant-backup/0.0?tab=results). It flags five production buckets that live in the single region `europe-west1`:

- `spv1eu-production-tfstate`
- `spv1eu-production-assets`
- `spv1eu-production-static`
- `spv1eu-production-upload-patches`
- `spv1eu-production-gcs-access-logs`

A regional outage or loss in `europe-west1` would take these out with no second copy. The test passes for multi-region or dual-region buckets. This plan moves all five to the **`EU` multi-region** without changing their names.

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Target location | **`EU` multi-region** | Simplest config (`location = "EU"`, no `custom_placement_config`). Cheapest redundant option. Data stays inside the EU, so the data-residency stance doesn't change. Accepted by Vanta. |
| Mechanism | **In-place [bucket relocation](https://docs.cloud.google.com/storage/docs/bucket-relocation/overview)** (`gcloud storage buckets relocate`), **not** recreate-and-copy | Relocation keeps the bucket name, so every URL and reference keeps working. A new bucket name is not workable for assets or tfstate (see below). |
| Not Terraform | Relocate out of band, then align Terraform | In `hashicorp/google` 7.18.0 (pinned in `terraform/envs/eu-production/.terraform.lock.hcl`), `location` and `custom_placement_config.data_locations` are both `ForceNew`. Changing `location` in Terraform plans a **destroy + recreate**, not a move. |
| Scope | **All 5 buckets**, no Vanta exceptions | The total is ~15 GB, so the cost difference is negligible. Moving everything keeps the Vanta test fully green without written exceptions for the ephemeral buckets. |
| Environments | **Production only** | The Vanta finding is prod-only. eu-test keeps `var.gcp_region`. |

### Why a new bucket name is off the table

- **assets.** The server builds the public URL `https://storage.googleapis.com/spv1eu-production-assets/<key>` (`ObjectStorageService.buildPublicUrlPrefixForAssetBucket` in `server/src/asset/object-storage.service.ts`). That URL is stored in several places:
  - Postgres `Asset.rehostedUrl` (`server/prisma/schema.prisma:1216`).
  - Pending asset-upload operations in `PublishPlanOperation.content`.
  - **Customers' own systems.** Notion stores it as an `external` hot-link (`server/src/remote-service/connectors/library/notion/notion-connector.ts:1597-1605`), and the next pull writes it back into users' git records. We can't rewrite those copies, so the name must survive. See also DEV-10982 / WSG-001 for why this bucket is intentionally public.
- **tfstate.** The name is hardcoded in the backend config (`terraform/envs/eu-production/backend.tf:5`). The bucket is also managed from inside the very state it stores (`terraform/envs/eu-production/eu-production.tf:141-175`). Renaming it would mean a state migration on top of a bucket swap.
- **The other three** are wired through Terraform outputs and env vars, so they could be renamed. But relocation is simpler and identical for all five, so one procedure covers everything.

## Starting state (2026-10-08)

Sizes are from read-only Cloud Monitoring `storage.googleapis.com/storage/v2/total_bytes` and `.../total_count` on 2026-10-08. Writers are from a read of the code and Terraform.

| Bucket | Terraform | Size | Objects | Writers |
|---|---|---:|---:|---|
| `-assets` | `terraform/modules/env/main.tf:633` | 15.0 GB | 71,809 | Rehost job via `file.save` (`object-storage.service.ts:96`) |
| `-gcs-access-logs` | `terraform/modules/env/main.tf:593` | 43 MB | 14,357 | GCS hourly usage-log delivery (`cloud-storage-analytics@google.com`) |
| `-tfstate` | `terraform/envs/eu-production/eu-production.tf:146` | 32 MB | 54 | Manual `terraform apply` only. CI never runs Terraform. |
| `-static` | `terraform/modules/static_bucket_lb/main.tf:10` | 0.5 MB | 44 | Manual `gcloud storage cp` of connector/model/OS icons. Terraform-managed `maintenance/*` objects (`terraform/modules/env/maintenance.tf:113-131`). |
| `-upload-patches` | `terraform/modules/env/main.tf:708` | ~0 | 2 | CLI and desktop presigned V4 PUT (`object-storage.service.ts:135-149`). Objects are deleted after 24h. |

The buckets themselves meet relocation's requirements, but the project doesn't (see [Prerequisite](#prerequisite-storage-intelligence)):

- `soft_delete_policy` is 7 days on every bucket, and relocation requires at least 7 days.
- Terraform sets no retention policy, CMEK, hierarchical namespace, Autoclass or bucket tags on any of them.
- No org policy restricts resource locations.
- The read-only SA can't describe the buckets (`storage.buckets.get` is denied), so the `--dry-run` in step 3 is the authoritative compatibility check.

### Prerequisite: Storage Intelligence

[Bucket relocation is only available with Storage Intelligence](https://docs.cloud.google.com/storage/docs/bucket-relocation/overview), configured for **both** the source and destination locations. The plan originally missed this. The 2026-10-09 rehearsal dry run failed with:

```
HTTPError 412: Storage Intelligence subscription is required in both the source and destination regions
to use this feature. The following locations are missing the subscription: 'EUROPE-WEST1, EU'.
```

Neither project has it. `gcloud storage intelligence-configs describe --project=<p>` returns `editionConfig: INHERIT` and `effectiveEdition: NONE` for both `spv1eu-test` and `spv1eu-production`. So no folder- or org-level config applies either.

| Edition | Cost | Notes |
|---|---|---|
| [`TRIAL`](https://docs.cloud.google.com/storage/docs/storage-intelligence/30-day-introductory-trial/overview) | No object management fee for 30 days | Includes relocation. Can be activated **once per project**. **Auto-upgrades to `STANDARD` and starts billing** unless disabled before day 30. |
| `STANDARD` | $0.0025 per 1,000 objects per month, across every bucket in scope | About $0.22/mo for either project (~86k objects in prod, ~88k in test) |

The approach is to enable `TRIAL` per project only for the relocation window, then disable it. The commands are in runbook [step 0](#0-enable-storage-intelligence-per-project) and [step 7](#7-close-out). `spv1eu-test` used its trial for the 2026-10-22 rehearsal and disabled it at teardown, so a future relocation in test would need `STANDARD`. `spv1eu-production` enabled its trial on 2026-10-23 at 15:18 UTC for the prod run; it expires 2026-11-22 at 15:18 UTC. This is a project-level, out-of-band config change, so it needs explicit approval. Enabling and disabling needs `storage.intelligenceConfigs.update` (Storage Admin).

```mermaid
flowchart LR
  subgraph CR[Cloud Run europe-west1: api / worker / cron]
    ENV[GCS_ASSET_BUCKET<br/>GCS_PATCH_UPLOAD_BUCKET<br/>services.tf:218-219, 518-519, 782-783]
  end
  ENV -->|file.save rehost| ASSETS[(assets)]
  ENV -->|sign V4 PUT, stream read| PATCHES[(upload-patches)]
  CLI[scratchmd CLI / desktop] -->|presigned PUT| PATCHES
  ASSETS -->|public URL storage.googleapis.com| EXT[Notion / Webflow / Airtable<br/>+ users' git records]
  LB[static.scratch.md HTTPS LB<br/>+ maintenance backend bucket] --> STATIC[(static)]
  TF[manual terraform apply] --> TFSTATE[(tfstate)]
  ASSETS & PATCHES & STATIC & TFSTATE -->|hourly usage logs| LOGS[(gcs-access-logs)]
```

Nothing depends on `europe-west1` specifically:

- Public and signed URLs use the global `storage.googleapis.com` host.
- The SDK uses its default global endpoint; no `GCS_API_ENDPOINT` is set in prod.
- Global LB backend buckets accept a bucket in any location.
- Neither backend bucket has CDN enabled.

## Cost check vs the cost-reduction plan (DEV-11808)

The [hosting cost review](../../dev-11808-scratch-hosting-cost-review.md) has no Cloud Storage line item. GCS is too small to show up next to Compute, Cloud Run and Cloud SQL. **This change doesn't conflict with it.**

| Item | Estimate |
|---|---|
| Storage, ~15 GB at ~+$0.006/GB-mo (EU multi-region ~$0.026 vs `europe-west1` ~$0.020, Standard) | **~+$0.10/mo** |
| Multi-region replication of new writes, plus higher Class A op prices | Cents/mo at current write volume |
| One-time relocation (data movement + ops on ~72k objects) | ~$1–2 one-time |
| Storage Intelligence (required for relocation) | $0 on `TRIAL` if disabled within 30 days. Otherwise ~$0.22/mo per project on `STANDARD`. |

Confirm the exact SKUs on the [Cloud Storage pricing page](https://cloud.google.com/storage/pricing) before executing. Even at several times these estimates the change stays well under $5/mo.

## How relocation behaves (what to expect)

Moving a single region to a multi-region is a **write-downtime relocation**. The timings below were measured in the 2026-10-22 rehearsal, on a ~500-object, 12 KB bucket. The 2026-10-23 prod run matched: dry runs took 21–24 min, static's copy ~20 min, and its finalize ~45 min.

1. **Dry run.** `--dry-run` starts its **own long-running operation**, and the bucket can't start a real relocation until it finishes. Starting one early returns `412: … there is an existing GCS long running operation`. The rehearsal's dry run took **~25 min**.
2. **Setup.** `progressPercent` stays at 0 until setup finishes. In the rehearsal the copy started **~29 min** after the relocation began.
3. **Incremental copy.** Data is copied to `EU` in the background.
   - **Reads and object writes keep working.**
   - **Bucket metadata is write-locked from the moment the relocation starts.** That covers IAM, CORS, lifecycle, logging, labels and versioning, so no `terraform apply` may touch these buckets until it finishes. The rehearsal confirmed it: a label update returned `412: This bucket is currently being relocated and bucket-level features cannot be modified`.
   - New XML-API multipart uploads fail. We don't use them; the patch upload is a single PUT.
   - It's ready to finalize when `finalizationState` is `READY` **and** `commonMetadata.progressPercent` is at least 99. `READY` can show up at 0%. With a live writer, progress can sit at 98–99%, because the newest writes are always still pending; that counts as caught up.
4. **Final sync** (`--finalize`). The bucket is write-locked and every object write fails until the sync completes.
   - `estimatedWriteDowntimeDuration` is **not a real estimate**. Google documents its minimum value as `7200s`, and the rehearsal reported exactly that.
   - **The rehearsal measured a ~40 min write lock.** The last write succeeded at 17:43:28 UTC (finalize was issued at ~17:43:29), writes failed from 17:44:01 to 18:23:06, and they worked again at 18:23:40. Writes resumed about 5 min before the operation reported `done` (18:28:56). Whether the lock grows with bucket size is unknown, so treat 40 min as a floor.
   - `--ttl` must be between **6h and 48h** (default 12h). If the write downtime exceeds it, the relocation reverts to the copy step and writes are re-enabled.
   - In-progress resumable uploads must finish before finalizing.
5. **Done.** `done: true`, `relocationState: SUCCEEDED` and `finalizationState: FINALIZED`. The rehearsal took ~85 min from start to done, plus the ~25-min dry run.

The whole relocation must finish within **28 days**. A failed relocation can't be retried to the same destination for 7–14 days.

### Impact of the write lock per bucket

| Bucket | During the final-sync write lock | Recovery |
|---|---|---|
| tfstate | `terraform apply` and state locking fail | Don't run Terraform. Nothing to recover. |
| static | Icon uploads fail. Reads and the LB keep serving. | Don't upload. Don't apply the maintenance-mode Terraform. |
| gcs-access-logs | GCS usage-log delivery may fail | **Possible small gap** in access logs for the lock window. GCS may or may not retry delivery; check the gap in step 4. |
| upload-patches | CLI/desktop publish fails at the patch PUT | The user retries the publish |
| assets | Asset rehosts fail | Self-heals: a failed rehost leaves `rehostedUrl` null, and the next rehost run selects `rehostedUrl: null` (`server/src/worker/jobs/job-definitions/rehost-assets.job.ts:83`) |

Expect **at least ~40 minutes** of write lock per bucket. The reported `estimatedWriteDowntimeDuration` is always at least 2h, so it can't be used to decide. For assets and upload-patches, 40+ minutes of failed rehosts and publishes is over the ~30-minute line at which the original plan said to quiesce writers. The options are:

- Quiesce writers with `terraform/tools/maintenance_mode.sh` during those two finalizes. It works through Cloud Armor and Cloud Run and doesn't write to the static bucket.
- With fewer than 10 external users, accept the failures in a low-traffic window.

**Decision for the prod run:** neither. The only active users were internal staff and Live Export workbooks. Live Export reads the assets bucket (rehosted URLs, at publish time) but never writes to assets or upload-patches, so the write locks didn't affect it. Maintenance mode would have stopped Live Export, creating an outage where the relocation caused none. Internal users were asked instead to hold desktop/CLI publishes and "Pull assets" for the ~45-min write window.

## Production run (2026-10-23)

All five buckets moved to `EU` during business hours PT, with **no user-facing outage**. Maintenance mode wasn't used, and Live Export kept running throughout (see [Impact of the write lock](#impact-of-the-write-lock-per-bucket)). Before starting, #on-call was told:

- no prod `terraform apply` and no static icon uploads until the all-clear
- during the announced ~45-min write window, no desktop/CLI publishes and no "Pull assets"

**Prep:**
- The Storage Intelligence trial was enabled (`editionConfig: TRIAL`, `effectiveEdition: STANDARD`).
- The `REHOSTED_ASSET_REAPER_DELETES_ENABLED` flag was turned off. It went back on after verification.

| Step (UTC) | Time | Notes |
|---|---|---|
| Storage Intelligence trial enabled | 15:18 | Expires 2026-11-22 15:18 UTC |
| **Wave 1:** static dry run | 15:24–15:46 | Passed; this was the first proof of prod permissions |
| static relocation started | 16:03 | |
| Dry runs for the other four | 16:03–16:28 | All passed |
| static `READY` at 99% | ~16:23 | Copy took ~20 min |
| static finalize → done | 16:27 → 17:12 | ~45-min finalize, ~69 min total; then `EU` / `multi-region` and the `static.scratch.md` load balancer returned `200` |
| **Wave 2:** tfstate, gcs-access-logs, upload-patches, assets started | After static was verified | All four reached `READY` at 99% |
| Wave 2 finalized back to back | Once all four were `READY` | upload-patches finished first, then tfstate and gcs-access-logs; assets finished last |

The exact wave 2 times are in each operation's `commonMetadata` (`createTime`, `endTime`). Operations, for the record:

- `projects/_/buckets/spv1eu-production-static/operations/CiQ2ZTUzMjRmZC1lY2U5LTQ3Y2QtOWZhYS0yOTFlNTMwYmJlMjQQBQ`
- `projects/_/buckets/spv1eu-production-tfstate/operations/CiRiMzM2OGZhYi1mNDMxLTRjMjAtYmJkMS0xYjAwZTEyZDQ2YjUQBQ`
- `projects/_/buckets/spv1eu-production-gcs-access-logs/operations/CiRkMTg4OThmMy1lZjUzLTQ0NDQtODBiYS0wNzI2OTkxNGRiMzMQBQ`
- `projects/_/buckets/spv1eu-production-upload-patches/operations/CiRkNTY1MWJiNC0zZWI5LTQ0OWEtYTNlMC0xNTdjNzFkNTEwMmQQBQ`
- `projects/_/buckets/spv1eu-production-assets/operations/CiQ3OTdjMWNjNi04ODdkLTRlMDctYWM1MC1lMmEwOWQ5ZTU5OTgQBQ`

The dry runs count every object version, so these are the amounts actually moved:

| Bucket | Objects | Size | Note |
|---|---:|---:|---|
| static | 44 | 0.48 MB | |
| tfstate | 60 | 34 MB | |
| gcs-access-logs | 18,729 | 96 MB | `estimatedWriteDowntimeDuration` 7204s |
| upload-patches | 13 | 69 KB | |
| assets | 71,809 | 14.99 GB | `estimatedWriteDowntimeDuration` 7216s. The same as the 2026-10-09 baseline, because the DEV-12324 reaper's deletes are still noncurrent versions. |

| Verification | Result |
|---|---|
| Location, all five buckets | `EU` / `multi-region` |
| `static.scratch.md` (load balancer → static bucket) | `HTTP/2 200` |
| A recent assets `rehostedUrl` | `HTTP/2 200` |
| gcs-access-logs | That day's usage logs present |
| upload-patches | An internal desktop/CLI publish succeeded end to end |
| tfstate | `terraform plan` read and locked state in the relocated bucket |
| Terraform alignment ([step 5](#5-align-terraform-isolated-mr-after-all-relocations-succeed), MR !3419) | `plan` showed no changes in `eu-production` and `eu-test` |
| Vanta `gcp-cloud-storage-redundant-backup` | Passes |

**Follow-ups:**
- Disable Storage Intelligence on `spv1eu-production` by 2026-11-17 ([step 7](#7-close-out)).
- Whether the write-lock hour's access logs were delivered is unverified (see [Open questions](#open-questions)).

## Runbook

Every step that changes GCP state needs explicit approval at execution time. Relocation and Storage Intelligence need `roles/storage.admin` (`storage.buckets.relocate`, `storage.bucketOperations.*`, `storage.intelligenceConfigs.update`). The per-dev read-only SAs don't have it.

**How to run the commands.** The commands are written out in full, with no shell variables. Paste them **one at a time**: most are steps in a sequence with waits in between, so pasting a whole block would run steps too early.

- Every command that changes GCP state passes `--configuration=admin`. That's a gcloud configuration logged in as an identity with Storage Admin on the project (for example `role_operations@`), so the shell's active config can stay read-only. If your admin configuration has a different name, change the flag.
- Read-only checks (Monitoring, `curl`, `terraform plan`) use your normal credentials.
- The only placeholders are `<DRY_RUN_OPERATION_ID>`, `<OPERATION_ID>` and `<REHOSTED_URL>`. The real relocate prints its operation name, and `gcloud storage operations list gs://<bucket>` shows every operation, including the dry run's. The ID is the last path segment of `name`.
- Expected output is written next to each command, never as a trailing `# …` comment. Interactive zsh only treats `#` as a comment when `setopt interactivecomments` is on. Otherwise a trailing comment becomes command arguments, and a `(…)` in it can fail with `zsh: unknown file attribute`.
- The `date -u -v-2d` syntax is macOS `date`.

Both rehearsals and the prod run used a personal Whalesync account through a separate `admin` configuration. In `spv1eu-test` it could create the bucket, enable and disable Storage Intelligence, and run the whole relocation. In `spv1eu-production` it could enable Storage Intelligence and relocate all five buckets.

### 0. Enable Storage Intelligence (per project)

Enable `TRIAL` on a project before its first dry run, and disable it after its last relocation succeeds (see [Prerequisite](#prerequisite-storage-intelligence)).

- Set a reminder for day 25 after enabling. If a relocation is still running then, decide whether to let it upgrade to `STANDARD` or cancel.
- Don't disable while any relocation operation is still in progress. What that would do to the operation is undocumented.

Before the rehearsal (step 1). Done on 2026-10-22, and disabled again at teardown:

```bash
gcloud --configuration=admin storage intelligence-configs enable --project=spv1eu-test --trial-edition
gcloud --configuration=admin storage intelligence-configs describe --project=spv1eu-test --format=json
```

Before the first prod relocation (step 3), and only once the relocation window is booked, because the trial is one-time per project. Done on 2026-10-23 at 15:18 UTC; it expires 2026-11-22 at 15:18 UTC:

```bash
gcloud --configuration=admin storage intelligence-configs enable --project=spv1eu-production --trial-edition
gcloud --configuration=admin storage intelligence-configs describe --project=spv1eu-production --format=json
```

After enabling, `effectiveEdition` should no longer be `NONE`. Note the trial's expiry date from the output.

### 1. Rehearsal in `spv1eu-test` (throwaway bucket)

Before touching prod, prove the relocation preserves what we rely on. Do this on a scratch bucket, **not** a Terraform-managed test bucket. Relocating a managed test bucket would drift it from `var.gcp_region`, and the next test apply would plan a replacement.

**Done on 2026-10-22, and it passed.** The first attempt, on 2026-10-09, stopped at the dry run with the Storage Intelligence 412. Re-running it needs step 0 on `spv1eu-test`, and since that project's one-time trial is now spent, it would have to be `STANDARD`.

#### Rehearsal results (2026-10-22)

| Check | Result |
|---|---|
| Location after | `EU` / `multi-region` |
| Bucket config (CORS, lifecycle, logging, versioning, soft delete, labels, uniform access, public access prevention) | Unchanged. The only addition is `"rpo": "DEFAULT"`, a field only multi- and dual-region buckets have. |
| IAM, including `allUsers` → `assetsObjectReader` | Unchanged |
| Live, all-version and soft-deleted object counts under `seed/` | 299 / 319 / 1 before and after: **noncurrent versions and soft-deleted objects carry over** |
| Public reads | 904 reads from 16:05 to 18:37 UTC, all `200`, including during the write lock |
| Metadata lock while relocating | Confirmed (`412 … bucket-level features cannot be modified`) |
| Dry run | ~25 min (16:08–16:33 UTC), `relocationState: SUCCEEDED`, `validateOnly: true` |
| Setup before the copy started | ~29 min (17:03–17:32 UTC) |
| `estimatedWriteDowntimeDuration` | `7200s`, Google's documented minimum |
| Measured write lock | **~40 min**: 70 consecutive failed writes, 17:44:01–18:23:06 UTC |
| Relocation start to done | ~85 min (17:03–18:29 UTC) |

**1. Create the bucket, shaped like `-assets`.** That means uniform bucket-level access, versioning, 7-day soft delete, `GET` CORS, noncurrent-version lifecycle, usage logging and `allUsers` object read:

```bash
gcloud --configuration=admin storage buckets create gs://spv1eu-test-relocation-rehearsal --project=spv1eu-test --location=europe-west1 --uniform-bucket-level-access --soft-delete-duration=7d

echo '[{"method": ["GET"], "origin": ["test.scratch.md"]}]' > /tmp/dev-11918-cors.json
echo '{"rule": [{"action": {"type": "Delete"}, "condition": {"daysSinceNoncurrentTime": 30}}]}' > /tmp/dev-11918-lifecycle.json

gcloud --configuration=admin storage buckets update gs://spv1eu-test-relocation-rehearsal --versioning --cors-file=/tmp/dev-11918-cors.json --lifecycle-file=/tmp/dev-11918-lifecycle.json --log-bucket=spv1eu-test-gcs-access-logs --update-labels=purpose=dev-11918-rehearsal

gcloud --configuration=admin storage buckets add-iam-policy-binding gs://spv1eu-test-relocation-rehearsal --member=allUsers --role=projects/spv1eu-test/roles/assetsObjectReader --format=none
```

**2. Seed and record the "before" state.** The commands create 300 objects, overwrite 20 of them (20 noncurrent versions), and delete all versions of one (1 soft-deleted object). With versioning on, a plain `rm` only makes an object noncurrent; it doesn't soft-delete it, hence `--all-versions`.

```bash
mkdir -p /tmp/dev-11918-seed /tmp/dev-11918-overwrite
for i in $(seq -f '%03g' 1 300); do echo "rehearsal object $i v1" > /tmp/dev-11918-seed/obj-$i.txt; done
for i in $(seq -f '%03g' 1 20); do echo "rehearsal object $i v2" > /tmp/dev-11918-overwrite/obj-$i.txt; done

gcloud --configuration=admin storage cp '/tmp/dev-11918-seed/*' gs://spv1eu-test-relocation-rehearsal/seed/
gcloud --configuration=admin storage cp '/tmp/dev-11918-overwrite/*' gs://spv1eu-test-relocation-rehearsal/seed/
gcloud --configuration=admin storage rm --all-versions gs://spv1eu-test-relocation-rehearsal/seed/obj-300.txt

gcloud --configuration=admin storage buckets describe gs://spv1eu-test-relocation-rehearsal --format=json > /tmp/dev-11918-before-describe.json
gcloud --configuration=admin storage buckets get-iam-policy gs://spv1eu-test-relocation-rehearsal --format=json > /tmp/dev-11918-before-iam.json
```

Then check the counts and the public URL. Expect `299` live, `319` with noncurrent versions, `1` soft-deleted, and `200`:

```bash
gcloud --configuration=admin storage ls 'gs://spv1eu-test-relocation-rehearsal/seed/**' | wc -l
gcloud --configuration=admin storage ls -a 'gs://spv1eu-test-relocation-rehearsal/seed/**' | wc -l
gcloud --configuration=admin storage ls --soft-deleted --exhaustive 'gs://spv1eu-test-relocation-rehearsal/seed/**' | wc -l
curl -so /dev/null -w '%{http_code}\n' https://storage.googleapis.com/spv1eu-test-relocation-rehearsal/seed/obj-002.txt
```

**3. Start the probes.** Run each in its own terminal and leave them running until item 5. The write probe writes under `probe/`, so the `seed/` counts stay comparable. Keep the machine awake (`caffeinate -i` in a spare terminal): if it sleeps, the loops pause and the logs show false gaps. If you have to restart a probe, change `tee` to `tee -a` so the log isn't overwritten.

Terminal A, a public read every 10s:

```bash
while true; do echo "$(date -u +%H:%M:%S) $(curl -so /dev/null -w '%{http_code}' https://storage.googleapis.com/spv1eu-test-relocation-rehearsal/seed/obj-002.txt)"; sleep 10; done | tee /tmp/dev-11918-read-probe.log
```

Terminal B, an object write every 30s:

```bash
while true; do if gcloud --configuration=admin storage cp /tmp/dev-11918-seed/obj-001.txt gs://spv1eu-test-relocation-rehearsal/probe/write-$(date -u +%H%M%S).txt >/dev/null 2>&1; then echo "$(date -u +%H:%M:%S) write ok"; else echo "$(date -u +%H:%M:%S) WRITE FAILED"; fi; sleep 30; done | tee /tmp/dev-11918-write-probe.log
```

**4. Relocate, monitor and finalize.** Run each command once, in order.

Dry run. No data moves, but it runs as its own operation (~25 min):

```bash
gcloud --configuration=admin storage buckets relocate gs://spv1eu-test-relocation-rehearsal --location=EU --dry-run
```

Find the dry run's operation ID, then repeat the `describe` until it shows `done: true` with a `response` and no `error`. A real relocation can't start before that:

```bash
gcloud --configuration=admin storage operations list gs://spv1eu-test-relocation-rehearsal
```

```bash
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-test-relocation-rehearsal/operations/<DRY_RUN_OPERATION_ID>
```

Start the relocation. Answer `y` to the warning prompt, and note the new operation ID it prints:

```bash
gcloud --configuration=admin storage buckets relocate gs://spv1eu-test-relocation-rehearsal --location=EU
```

Probe the metadata lock. This should be **rejected** with `412 … bucket-level features cannot be modified`:

```bash
gcloud --configuration=admin storage buckets update gs://spv1eu-test-relocation-rehearsal --update-labels=probe=metadata-lock
```

Repeat this every 15–30 min until it shows `finalizationState: READY` and `commonMetadata.progressPercent` of at least 99. Stop if it shows `BLOCKED_ON_ERRORS` or `FAILED`.

```bash
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-test-relocation-rehearsal/operations/<OPERATION_ID>
```

Finalize, which starts the write lock, and note the time. `--ttl` must be between 6h and 48h:

```bash
gcloud --configuration=admin storage buckets relocate --operation=projects/_/buckets/spv1eu-test-relocation-rehearsal/operations/<OPERATION_ID> --finalize --ttl=6h
```

Repeat the same `describe` every 10–15 min. During the lock it shows `relocationState: FINALIZING` and `finalizationState: RUNNING` at 99% with no visible progress, which is normal. Wait for `done: true`, `relocationState: SUCCEEDED` and `finalizationState: FINALIZED`.

**5. Compare against "before."** First confirm Terminal B is printing `write ok` again, then stop both probes with Ctrl-C.

Location. Expect `EU` and `multi-region`:

```bash
gcloud --configuration=admin storage buckets describe gs://spv1eu-test-relocation-rehearsal --format='value(location,location_type)'
```

After snapshots:

```bash
gcloud --configuration=admin storage buckets describe gs://spv1eu-test-relocation-rehearsal --format=json > /tmp/dev-11918-after-describe.json
gcloud --configuration=admin storage buckets get-iam-policy gs://spv1eu-test-relocation-rehearsal --format=json > /tmp/dev-11918-after-iam.json
```

Config diff. Expect a single added line, `"rpo": "DEFAULT"`:

```bash
diff <(jq 'del(.location, .location_type, .update_time, .metageneration)' /tmp/dev-11918-before-describe.json) <(jq 'del(.location, .location_type, .update_time, .metageneration)' /tmp/dev-11918-after-describe.json)
```

IAM diff. Expect no output:

```bash
diff <(jq 'del(.etag)' /tmp/dev-11918-before-iam.json) <(jq 'del(.etag)' /tmp/dev-11918-after-iam.json)
```

Counts. Expect `299`, `319` and `1` again:

```bash
gcloud --configuration=admin storage ls 'gs://spv1eu-test-relocation-rehearsal/seed/**' | wc -l
gcloud --configuration=admin storage ls -a 'gs://spv1eu-test-relocation-rehearsal/seed/**' | wc -l
gcloud --configuration=admin storage ls --soft-deleted --exhaustive 'gs://spv1eu-test-relocation-rehearsal/seed/**' | wc -l
```

Read probe. Expect no output, meaning every read returned `200`:

```bash
grep -v ' 200$' /tmp/dev-11918-read-probe.log
```

Measured write lock: the first failure, the last failure, and the number of failures:

```bash
grep 'WRITE FAILED' /tmp/dev-11918-write-probe.log | head -1
grep 'WRITE FAILED' /tmp/dev-11918-write-probe.log | tail -1
grep -c 'WRITE FAILED' /tmp/dev-11918-write-probe.log
```

**6. Tear down.** Keep the probe logs as evidence, delete the bucket and disable Storage Intelligence. The `describe` should return a 404, and the final check should print `NONE`.

```bash
mkdir -p ~/dev-11918-rehearsal-logs
cp /tmp/dev-11918-read-probe.log /tmp/dev-11918-write-probe.log ~/dev-11918-rehearsal-logs/
```

```bash
gcloud --configuration=admin storage rm -r --all-versions gs://spv1eu-test-relocation-rehearsal
gcloud --configuration=admin storage buckets describe gs://spv1eu-test-relocation-rehearsal
gcloud --configuration=admin storage intelligence-configs disable --project=spv1eu-test
gcloud --configuration=admin storage intelligence-configs describe --project=spv1eu-test --format='value(effectiveIntelligenceConfig.effectiveEdition)'
rm -rf /tmp/dev-11918-*
```

Record the results in [Rehearsal results](#rehearsal-results-2026-10-22).

### 2. Prep

- Announce a **prod Terraform freeze** for the five buckets, from the first relocate until the step 5 MR is merged and planned clean.
- Draft the step 5 Terraform MR in advance.
- Turn the `REHOSTED_ASSET_REAPER_DELETES_ENABLED` PostHog flag off before relocating assets, and back on after step 4 passes (DEV-12324). The nightly rehosted-asset reaper deletes unreferenced objects from that bucket, and its deletes would fail under the finalize write lock.
- Record the baseline size and object count per bucket, and re-run it on the day of the relocation. The `location` column also confirms each move later, once it flips to `eu`. The metric lags by a few hours.

```bash
curl -s -G "https://monitoring.googleapis.com/v3/projects/spv1eu-production/timeSeries" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: spv1eu-production" \
  --data-urlencode 'filter=metric.type="storage.googleapis.com/storage/v2/total_bytes" AND resource.type="gcs_bucket"' \
  --data-urlencode "interval.startTime=$(date -u -v-2d +%Y-%m-%dT%H:%M:%SZ)" \
  --data-urlencode "interval.endTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --data-urlencode "aggregation.alignmentPeriod=86400s" \
  --data-urlencode "aggregation.perSeriesAligner=ALIGN_MAX" \
  --data-urlencode "aggregation.crossSeriesReducer=REDUCE_SUM" \
  --data-urlencode "aggregation.groupByFields=resource.label.bucket_name" \
  --data-urlencode "aggregation.groupByFields=resource.label.location" \
  | jq -r '.timeSeries[] | [.resource.labels.bucket_name, .resource.labels.location, (.points[0].value | .int64Value // .doubleValue)] | @tsv'

curl -s -G "https://monitoring.googleapis.com/v3/projects/spv1eu-production/timeSeries" \
  -H "Authorization: Bearer $(gcloud auth print-access-token)" -H "x-goog-user-project: spv1eu-production" \
  --data-urlencode 'filter=metric.type="storage.googleapis.com/storage/v2/total_count" AND resource.type="gcs_bucket"' \
  --data-urlencode "interval.startTime=$(date -u -v-2d +%Y-%m-%dT%H:%M:%SZ)" \
  --data-urlencode "interval.endTime=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --data-urlencode "aggregation.alignmentPeriod=86400s" \
  --data-urlencode "aggregation.perSeriesAligner=ALIGN_MAX" \
  --data-urlencode "aggregation.crossSeriesReducer=REDUCE_SUM" \
  --data-urlencode "aggregation.groupByFields=resource.label.bucket_name" \
  --data-urlencode "aggregation.groupByFields=resource.label.location" \
  | jq -r '.timeSeries[] | [.resource.labels.bucket_name, .resource.labels.location, (.points[0].value | .int64Value // .doubleValue)] | @tsv'
```

Baseline from 2026-10-09. This is **out of date for assets**: the DEV-12324 rehosted-asset reaper has since deleted most of that bucket's live objects. Versioning keeps deleted objects as noncurrent versions for 30 days, and relocation carries those over too, so re-run both queries before relocating:

| Bucket | Location | Size | Objects |
|---|---|---:|---:|
| `-assets` | europe-west1 | 14.989 GB | 71,809 |
| `-gcs-access-logs` | europe-west1 | 0.043 GB | 14,357 |
| `-tfstate` | europe-west1 | 0.032 GB | 54 |
| `-static` | europe-west1 | 0.000 GB | 44 |
| `-upload-patches` | europe-west1 | 0.000 GB | 2 |

### 3. Relocate each bucket, lowest risk first

Order: **static → tfstate → gcs-access-logs → upload-patches → assets.** Needs step 0 on `spv1eu-production` first; without it, every dry run returns the 412.

**As executed on 2026-10-23: two waves.** Wave 1 took static end to end as the prod canary; its dry run was the first proof the admin identity could relocate in prod. The other four dry runs ran while static copied. Once static was verified, wave 2 started tfstate, gcs-access-logs, upload-patches and assets together. They were finalized back to back once all four showed `READY`, so their write locks overlapped into one window. Don't start wave 2 until wave 1 is done: Google doesn't say whether a *cancelled* relocation also blocks retries for 7–14 days, the way a failed one does.

Every bucket uses the same seven commands. Run them one at a time, moving on only when each one's condition is met:

1. **Dry run.** No data moves, but it runs as its own operation (~25 min in the rehearsal).
2. **List operations** to get the dry run's operation ID, and later the real one's.
3. **Wait for the dry run.** Repeat the `describe` until it shows `done: true` with a `response` and no `error`. A real relocation started before then fails with `412: … existing GCS long running operation`.
4. **Start the relocation.** Answer `y` to the warning prompt and note the new operation ID.
5. **Monitor the copy.** Repeat the `describe` until `finalizationState` is `READY` and `commonMetadata.progressPercent` is at least 99. Setup took ~29 min in the rehearsal. With live writers, progress can sit at 98–99%, which counts as caught up.
6. **Finalize** in the low-traffic window. This starts the write lock (~40 min in the rehearsal), so note the time. `--ttl` must be between 6h and 48h; if the lock outlasts it, writes are re-enabled and the relocation returns to the copy step.
7. **Monitor the finalize.** Repeat the `describe` until `done: true`, `relocationState: SUCCEEDED` and `finalizationState: FINALIZED`. While locked it shows `FINALIZING` / `RUNNING` at 99% with no visible progress, which is normal.

Stop and investigate on `BLOCKED_ON_ERRORS`, `FAILED` or `CANCELLED`. Each bucket also has a separate command that **aborts the relocation before finalizing** and leaves the bucket where it was.

#### 3a. static

```bash
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-static --location=EU --dry-run
gcloud --configuration=admin storage operations list gs://spv1eu-production-static
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-static/operations/<DRY_RUN_OPERATION_ID>
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-static --location=EU
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-static/operations/<OPERATION_ID>
gcloud --configuration=admin storage buckets relocate --operation=projects/_/buckets/spv1eu-production-static/operations/<OPERATION_ID> --finalize --ttl=6h
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-static/operations/<OPERATION_ID>
```

Abort before finalizing:

```bash
gcloud --configuration=admin storage operations cancel projects/_/buckets/spv1eu-production-static/operations/<OPERATION_ID>
```

#### 3b. tfstate

Nobody may run `terraform apply` against prod until this finishes.

```bash
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-tfstate --location=EU --dry-run
gcloud --configuration=admin storage operations list gs://spv1eu-production-tfstate
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-tfstate/operations/<DRY_RUN_OPERATION_ID>
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-tfstate --location=EU
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-tfstate/operations/<OPERATION_ID>
gcloud --configuration=admin storage buckets relocate --operation=projects/_/buckets/spv1eu-production-tfstate/operations/<OPERATION_ID> --finalize --ttl=6h
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-tfstate/operations/<OPERATION_ID>
```

Abort before finalizing:

```bash
gcloud --configuration=admin storage operations cancel projects/_/buckets/spv1eu-production-tfstate/operations/<OPERATION_ID>
```

#### 3c. gcs-access-logs

```bash
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-gcs-access-logs --location=EU --dry-run
gcloud --configuration=admin storage operations list gs://spv1eu-production-gcs-access-logs
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-gcs-access-logs/operations/<DRY_RUN_OPERATION_ID>
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-gcs-access-logs --location=EU
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-gcs-access-logs/operations/<OPERATION_ID>
gcloud --configuration=admin storage buckets relocate --operation=projects/_/buckets/spv1eu-production-gcs-access-logs/operations/<OPERATION_ID> --finalize --ttl=6h
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-gcs-access-logs/operations/<OPERATION_ID>
```

Abort before finalizing:

```bash
gcloud --configuration=admin storage operations cancel projects/_/buckets/spv1eu-production-gcs-access-logs/operations/<OPERATION_ID>
```

#### 3d. upload-patches

Finalize in the low-traffic window: CLI and desktop publishes fail for the whole write lock (~40 min or more).

```bash
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-upload-patches --location=EU --dry-run
gcloud --configuration=admin storage operations list gs://spv1eu-production-upload-patches
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-upload-patches/operations/<DRY_RUN_OPERATION_ID>
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-upload-patches --location=EU
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-upload-patches/operations/<OPERATION_ID>
gcloud --configuration=admin storage buckets relocate --operation=projects/_/buckets/spv1eu-production-upload-patches/operations/<OPERATION_ID> --finalize --ttl=6h
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-upload-patches/operations/<OPERATION_ID>
```

Abort before finalizing:

```bash
gcloud --configuration=admin storage operations cancel projects/_/buckets/spv1eu-production-upload-patches/operations/<OPERATION_ID>
```

#### 3e. assets

Before starting, turn the `REHOSTED_ASSET_REAPER_DELETES_ENABLED` PostHog flag off (step 2). Finalize in the low-traffic window: asset rehosts fail for the whole write lock (~40 min or more), then self-heal.

```bash
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-assets --location=EU --dry-run
gcloud --configuration=admin storage operations list gs://spv1eu-production-assets
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-assets/operations/<DRY_RUN_OPERATION_ID>
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-assets --location=EU
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-assets/operations/<OPERATION_ID>
gcloud --configuration=admin storage buckets relocate --operation=projects/_/buckets/spv1eu-production-assets/operations/<OPERATION_ID> --finalize --ttl=6h
gcloud --configuration=admin storage operations describe projects/_/buckets/spv1eu-production-assets/operations/<OPERATION_ID>
```

Abort before finalizing:

```bash
gcloud --configuration=admin storage operations cancel projects/_/buckets/spv1eu-production-assets/operations/<OPERATION_ID>
```

### 4. Verify each bucket

Location: each line should print `EU  multi-region` once that bucket's relocation succeeds.

```bash
gcloud --configuration=admin storage buckets describe gs://spv1eu-production-static --format='value(location,location_type)'
gcloud --configuration=admin storage buckets describe gs://spv1eu-production-tfstate --format='value(location,location_type)'
gcloud --configuration=admin storage buckets describe gs://spv1eu-production-gcs-access-logs --format='value(location,location_type)'
gcloud --configuration=admin storage buckets describe gs://spv1eu-production-upload-patches --format='value(location,location_type)'
gcloud --configuration=admin storage buckets describe gs://spv1eu-production-assets --format='value(location,location_type)'
```

Size and object count: re-run the two step 2 queries. They should match the baseline taken on the day of the relocation, with `location` now `eu`. The metric lags by a few hours.

Per-bucket checks:

- **static:** expect `HTTP/2 200`.

  ```bash
  curl -sI https://static.scratch.md/connector-icons/airtable.svg | head -1
  ```

- **assets:** pick a recent rehosted URL with the read-only DB script and expect `200`. A pull with asset rehosting should also produce new rehosted URLs.

  ```bash
  terraform/tools/connect_to_gcp_db_readonly.sh production 'SELECT "rehostedUrl" FROM "Asset" WHERE "rehostedUrl" IS NOT NULL ORDER BY "rehostedAt" DESC LIMIT 1'
  curl -sI '<REHOSTED_URL>' | head -1
  ```

- **upload-patches:** a CLI `scratchmd` publish succeeds end to end.
- **tfstate:** `plan` must read and lock state. Expect replacement drift on the relocated buckets until step 5. **Don't apply.**

  ```bash
  terraform -chdir=terraform/envs/eu-production init
  terraform -chdir=terraform/envs/eu-production plan
  ```

- **gcs-access-logs:** today's hourly usage logs keep arriving after the write lock lifts. The newest timestamps in the object names should be later than the finalize.

  ```bash
  gcloud --configuration=admin storage ls "gs://spv1eu-production-gcs-access-logs/spv1eu-production-assets_usage_$(date -u +%Y_%m_%d)_*"
  ```

### 5. Align Terraform (isolated MR, after all relocations succeed)

**Done in MR !3419**, merged 2026-10-23. Both plans showed no changes, including no `rpo` diff, so nothing was applied.

Until this lands, any prod `terraform plan` shows `-/+ … must be replaced` for every relocated bucket. `force_destroy = false` blocks deleting a non-empty bucket, but **upload-patches is often empty and could really be destroyed and recreated in `europe-west1`**. Keep the freeze until this MR is planned clean.

- In `terraform/modules/env/variables.tf`, add `gcs_bucket_location`, defaulting to `null` and resolved as `coalesce(var.gcs_bucket_location, var.gcp_region)`, so eu-test is unchanged.
- Use it for `google_storage_bucket.gcs_access_logs`, `.assets`, `.upload_patches`, and for `module.static_bucket_lb`'s `bucket_location` (`terraform/modules/env/main.tf:767`).
- Set `gcs_bucket_location = "EU"` in `terraform/envs/eu-production/eu-production.tf`.
- Change `google_storage_bucket.tfstate` to `location = "EU"` (`eu-production.tf:149`).
- After relocation, each bucket gains `rpo = "DEFAULT"` (rehearsal finding). Terraform doesn't set `rpo` on these buckets. If the plan shows an `rpo` change, add `rpo = "DEFAULT"` to them rather than letting Terraform change it.
- **Gate:** both plans must show **no changes** for the buckets. Any `must be replaced` means stop and investigate. Never `-auto-approve`.

```bash
terraform -chdir=terraform/envs/eu-production plan
terraform -chdir=terraform/envs/eu-test plan
```

### 6. Rollback

Before finalizing, that bucket's step 3 abort command cancels the relocation and leaves the bucket where it was.

After a successful relocation, move the bucket back with another write-downtime relocation. It has the same steps, timings and 28-day limit. Run that bucket's dry-run line below, and wait for the dry run to show `done: true` before running its start line. Then monitor and finalize with that bucket's step 3 `describe` and `--finalize` commands, using the new operation ID. Revert the step 5 MR to match.

```bash
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-static --location=europe-west1 --dry-run
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-static --location=europe-west1

gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-tfstate --location=europe-west1 --dry-run
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-tfstate --location=europe-west1

gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-gcs-access-logs --location=europe-west1 --dry-run
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-gcs-access-logs --location=europe-west1

gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-upload-patches --location=europe-west1 --dry-run
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-upload-patches --location=europe-west1

gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-assets --location=europe-west1 --dry-run
gcloud --configuration=admin storage buckets relocate gs://spv1eu-production-assets --location=europe-west1
```

Storage Intelligence must still be enabled on the project for a rollback. Don't do step 7 until you're confident no rollback is needed, and stay within the trial's 30 days.

### 7. Close out

- Re-run the Vanta test and confirm all five buckets pass. **Done 2026-10-23.**
- **Still to do, by 2026-11-17:** disable Storage Intelligence on prod and confirm it reports `NONE`. Test was already disabled at the rehearsal teardown, so its `describe` should already print `NONE`.

  ```bash
  gcloud --configuration=admin storage intelligence-configs disable --project=spv1eu-production
  gcloud --configuration=admin storage intelligence-configs describe --project=spv1eu-production --format='value(effectiveIntelligenceConfig.effectiveEdition)'
  gcloud --configuration=admin storage intelligence-configs describe --project=spv1eu-test --format='value(effectiveIntelligenceConfig.effectiveEdition)'
  ```

- Lift the Terraform freeze (done when !3419 merged), close DEV-11918, and move this doc to `docs/ops/plans/resolved/`. **Done 2026-10-23.**

## Open questions

All resolved except the access-log one.

- ~~Storage Intelligence on prod?~~ **`TRIAL` enabled** on 2026-10-23 at 15:18 UTC; it expires 2026-11-22 at 15:18 UTC. **Disable by 2026-11-17** ([step 7](#7-close-out)).
- ~~Quiesce writers?~~ **No.** Live Export doesn't write to the locked buckets, and maintenance mode would have stopped it. See [Impact of the write lock](#impact-of-the-write-lock-per-bucket).
- ~~Overlap buckets?~~ **Yes, in two waves.** See [step 3](#3-relocate-each-bucket-lowest-risk-first).
- ~~Do noncurrent versions and soft-deleted objects carry over?~~ **Yes.** The 2026-10-22 rehearsal kept 319 versions and 1 soft-deleted object.
- ~~Who runs it, and when?~~ Chris Hoefgen, on 2026-10-23 during business hours PT.
- ~~Exact pricing SKUs?~~ Not checked before executing. About 15 GB moved, so the ongoing difference stays at cents per month.
- **Still open:** does GCS **retry usage-log delivery** into `gcs-access-logs` while it's write-locked, or is that window lost? Today's logs were present after the move, but nobody checked whether the hour of the wave 2 write window has its own log object. To check, list that day's objects and look for that hour:

  ```bash
  gcloud --configuration=admin storage ls "gs://spv1eu-production-gcs-access-logs/spv1eu-production-assets_usage_2026_10_23_*"
  ```
