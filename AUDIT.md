# Spinner Codebase Audit

**Date:** 2026-03-25
**Branch:** cfonger-4

---

## High Priority

### Security

1. ~~**CORS wildcard + credentials**~~ — Fixed in cfonger-5. CORS now uses `ScratchConfigService.getClientBaseUrl()` per environment.
2. **Rate limiter fails open** — `server/src/rate-limiter/api-rate-limit.guard.ts` returns `true` when Redis is unavailable, silently disabling all rate limiting.
3. **No SAST or dependency scanning in CI** — Only secret detection is enabled in `.gitlab-ci.yml`. Missing `yarn audit`, `cargo audit`, and SAST templates.
4. **scratch-git GCE deletion_protection = false** — `terraform/modules/scratch_git_gce/main.tf` — this is a persistent data node that could be accidentally deleted.

### Performance

5. **N+1 query in workbook controller** — `server/src/workbook/workbook.controller.ts:88-93` fetches schedules per-workbook in a `Promise.all(map(...))`. Should batch into a single query.
6. **sync.service.ts is 2,137 lines** — `server/src/sync/sync.service.ts` handles validation, mapping, git interaction, and DB transactions. Should be split into focused services.

### Client Architecture

7. **TreeNode.tsx is 1,936 lines** — `client/src/app/workbook/[id]/components/Sidebar/TreeNode.tsx` manages tree rendering, 20+ modal states, and API calls in one component. Needs decomposition.
8. **`reconcileWithWorkbook()` is a TODO** — `client/src/stores/workbook-ui-store.ts:108` has an unimplemented reconciliation function, risking stale UI state after server updates.
9. **No error boundaries** — No `error.tsx` files for Next.js App Router error handling. An unhandled error in any component can crash the entire page.

---

## Medium Priority

### Code Quality

10. ~~**Duplicate module import**~~ — Fixed in cfonger-6. Removed duplicate `ScratchGitModule` import in `workers.module.ts`.
11. **Missing composite index** — `Schedule.enabled` + `Schedule.nextRunAt` are queried together by the cron service but have no composite index in the Prisma schema.
12. **Missing `useMemo`** — `client/src/app/workbook/[id]/review/page.tsx:61-86` runs `groupFilesBySource` on every render.
13. **`dompurify` installed but never imported** — Dead dependency in `client/package.json`.

### Infrastructure

14. **No `.dockerignore` files** — All services send full build context including `node_modules`, `.git`, test files.
15. **No test coverage thresholds** — Jest runs without `--coverage` enforcement. Code with 0% coverage can merge.
16. **E2E tests configured but not in CI** — Playwright is set up but no CI job runs it.
17. **Point-in-time recovery disabled on CloudSQL** — Comment says "bad for performance" but the tradeoff isn't documented.

### Accessibility

18. **Tree navigation lacks ARIA roles** — TreeNode doesn't use `role="tree"` / `role="treeitem"` / `aria-expanded`.

---

## Low Priority

19. **Hardcoded `APP_ENV=test`** in Dockerfiles — Should be set at deployment time, not baked into the image.
20. **No version embedding in Go CLI** — `scratch-cli` binary doesn't include a version string.
21. **SWR cache key fragility** — `client/src/hooks/use-jobs.ts` concatenates filter objects as strings for cache keys; structural changes could cause cache misses.
22. **Unsafe double-casting** — Several server files use `as unknown as X` patterns instead of proper type definitions.
23. **Smoke test timeout is 60 minutes** — Could likely be reduced to 30-40m.
24. **`test-api-fakes/*` workspace sprawl** — 7 small Docker-only services each with their own Jest config; could be consolidated.

---

## What's Working Well

- **Secret management** is solid — GCP Secret Manager in production, encrypted credentials via `CredentialEncryptionService`, proper Clerk token refresh
- **Terraform** is well-structured with modular design, SSL enforcement, private networking, audit logging, and automated snapshots
- **CI/CD** has good change-based triggers, OIDC auth, and integration tests on real Postgres
- **Zustand + SWR** patterns are clean with a custom lint rule preventing common re-render traps
- **Docker builds** use multi-stage, non-root users, and dumb-init for signal handling
- **Turbo** caching and dependency ordering are properly configured
