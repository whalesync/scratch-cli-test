# Pull Job V1 Cleanup Plan

**Date:** 2026-04-20
**Status:** Phase 1 complete — Phase 2 (Terraform) pending deploy
**Goal:** Remove the V1 pull job handler and the `PULL_JOB_V2` feature flag, making V2 the only implementation.

## Background

The pull-linked-folder-files job has two implementations:

- **V1** (`pull-linked-folder-files.job.ts`): Sequential folder-by-folder processing
- **V2** (`pull-linked-folder-files-v2.job.ts`): Two-phase architecture — parallel fetch, then sequential process

V2 is enabled via `PULL_JOB_V2=true` in both **eu-test** and **eu-production** Terraform configs. V1 is dead code.

## Files to Delete or Move

| File                                                                          | Reason                                                     |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.ts`      | V1 handler (delete)                                        |
| `server/src/worker/jobs/job-definitions/pull-linked-folder-files.job.spec.ts` | V1 unit tests (delete)                                     |
| `docs/pull-job-refactor-plan.md`                                              | V1 design doc (historical, move to `docs/plans/resolved/`) |

## Files to Modify

### 1. `server/src/worker/job-handler.service.ts`

- Remove import of `PullLinkedFolderFilesJobHandler` (line 29)
- Remove the `PULL_JOB_V2` feature flag check (lines 67-72)
- Instantiate `PullLinkedFolderFilesV2JobHandler` directly in the `PullLinkedFolderFiles` case

### 2. `server/src/worker/jobs/job-definitions/pull-linked-folder-files-v2.job.ts`

- **Rename** to `pull-linked-folder-files.job.ts` (it becomes the only implementation)
- Rename class `PullLinkedFolderFilesV2JobHandler` → `PullLinkedFolderFilesJobHandler`
- Rename job progress type `PullLinkedFolderFilesV2JobProgress` → `PullLinkedFolderFilesJobProgress`
- Move shared types (`PullLinkedFolderFilesPublicProgress`, `PullLinkedFolderFilesJobDefinition`) that are currently defined in the V1 file into this file
- Update the V2 test file name accordingly

### 3. `server/src/worker/jobs/union-types.ts`

- Update import path if the file is renamed

### 4. `server/src/worker-enqueuer/bull-enqueuer.service.ts`

- Update import path for `PullLinkedFolderFilesJobDefinition` if moved

### 5. Terraform — Remove `PULL_JOB_V2` variable

| File                                                      | Change                                             |
| --------------------------------------------------------- | -------------------------------------------------- |
| `terraform/modules/env/variables.tf` (line 379-383)       | Delete variable definition                         |
| `terraform/modules/env/services.tf` (lines 197, 447, 677) | Remove env var from API, cron, and worker services |
| `terraform/envs/eu-production/eu-production.tf` (line 47) | Remove `pull_job_v2 = true`                        |
| `terraform/envs/eu-test/eu-test.tf` (line 46)             | Remove `pull_job_v2 = true`                        |

### 6. `server/src/job/README.md` (line 347)

- Remove `PULL_JOB_V2` from environment variable reference

### 7. `server/test/integration/fetch-edit-publish.spec.ts`

- Update import to use the renamed handler (currently imports V1 on line 103, instantiates on lines 156/448)
- Switch to V2 handler or update import path

### 8. `docs/pull-job-performance-plan.md`

- Move to `docs/plans/resolved/` (V2 design doc — plan is fully implemented)

## Execution Order

### Phase 1: Code cleanup (deploy first)

The server must still accept `PULL_JOB_V2` as an env var without breaking, so the Terraform side stays untouched until after this deploys.

1. **Move shared types** from V1 file into V2 file (so nothing breaks when V1 is deleted)
2. **Delete V1 files** (handler + spec)
3. **Rename V2** → remove "V2" suffix from file, class, and type names
4. **Update all imports** across job-handler.service, union-types, bull-enqueuer, integration tests
5. **Remove feature flag** from job-handler.service.ts — instantiate the handler directly (ignore the env var; it's harmless until Terraform removes it)
6. **Update docs** — remove env var reference, move resolved plans
7. **Verify** — `yarn build && yarn lint && yarn test`
8. **Deploy** to test and production

### Phase 2: Terraform cleanup (after Phase 1 is deployed)

Once the deployed code no longer reads `PULL_JOB_V2`, safely remove it from infrastructure config.

1. Remove `pull_job_v2 = true` from `terraform/envs/eu-production/eu-production.tf`
2. Remove `pull_job_v2 = true` from `terraform/envs/eu-test/eu-test.tf`
3. Remove `PULL_JOB_V2` env var from `terraform/modules/env/services.tf` (API, cron, worker)
4. Delete variable definition from `terraform/modules/env/variables.tf`
5. `terraform plan` + `terraform apply` per environment

## Risks

- **Low risk**: V2 is already running in all environments. No behavioral change.
- **Integration tests** currently use V1 handler directly — need to swap to V2 handler.
- **Phase 2 ordering matters**: Terraform must not remove the env var before the code stops reading it, otherwise a rollback to old code would fall back to V1 (which will no longer exist). Deploying Phase 1 first eliminates this risk.
