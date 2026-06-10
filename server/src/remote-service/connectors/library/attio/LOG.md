# Attio connector — activity log

Plain-language, append-only journal of operations performed on the Attio connector. STATE.md says *what's covered*; this says *what was done, in order*. `[hh:mm:ss]` is wall-clock; one operation per line.

## 2026-06-10 — DEV-10303 code review (desk only, no live ops)

Reviewed the connector and bootstrapped its docs. **No service/CLI operations were run** — code review + documentation only; every STATE.md coverage cell is `⬜` (unverified).

[13:55:00] [Research] Cold-read all connector files (attio-connector.ts, attio-api-client.ts, attio-types.ts, attio-json-schema.ts, attio-write-shape.ts, attio-default-view.ts, __tests__/) and the publish pipeline (publish-plan-run.service.ts, diff-utils.ts pickByShape) to confirm the `changedFields` contract is nested (matches `updateRecords`).
[13:56:00] [Research] Researched Attio API currency (web): REST API is v2 (current, no v3, no version header), `GET /v2/self` not deprecated, no official SDK (community SDKs only). Verdict: up to date.
[13:57:00] [Research] Created STATE.md from the code (all coverage ⬜; TODOs seeded from review gaps: no FK declared, readonly-labeling gap, list-entry parent readonly-on-create, users/custom-objects/tasks/notes planned, incremental not wired, dead `listObjects`).
[13:58:00] [Research] Updated /connector-build skill (SKILL.md + coverage-template.md): Endpoints section must now lead with an "API version & client" currency line.
