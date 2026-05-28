---
name: scratch-posthog
description: Reference for interacting with the Scratch PostHog projects via the PostHog MCP — project IDs, the discover/info/call protocol, and concrete recipes for (1) creating/updating/deleting feature flags and (2) adding new analytics properties to existing events. Use when the user asks to create, modify, or delete a PostHog feature flag, or to instrument a new metric on top of existing tracked events.
user-invocable: true
allowed-tools:
  - mcp__posthog__exec
---

## Projects

This monorepo has two PostHog projects under the Whalesync organization. **Always confirm or set the active project before running write operations** — switching is the difference between a real prod change and a test sandbox.

| Project        | ID       | When to use                                                                                                                                     |
| -------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Scratch - Prod | `214130` | Live customer traffic. Real flags. Be deliberate.                                                                                               |
| Scratch - Test | `225935` | Local dev + deployed test env both point here (via `POSTHOG_API_KEY` in `server/.env`). Use for smoke-testing flag wiring before touching Prod. |

Switch with:

```
posthog:exec({ "command": "call switch-project {\"projectId\": 225935}" })
```

The MCP only echoes its current project context when you switch or run `call project-get`; otherwise it silently uses whatever was last set in the session. **When in doubt, switch explicitly.**

### Two-project workflow — flags and other entities are NOT synced

PostHog treats each project as a fully independent workspace. Flags, insights, dashboards, cohorts, etc. created in Test do **not** appear in Prod, and vice versa. The MCP also has no "copy across projects" tool. So every write operation that needs to land in both projects has to be **performed twice — once per project — with an explicit `switch-project` call between them.**

Standard pattern for a flag that needs to exist everywhere:

```
# 1. Start in Test (id 225935)
call switch-project {"projectId": 225935}
call create-feature-flag { ... }     # → returns Test flag id (e.g. 692003)

# 2. Smoke-test wiring locally — local dev hits Test via server/.env

# 3. When the wiring is verified, mirror into Prod
call switch-project {"projectId": 214130}
call feature-flag-get-all {"search": "YOUR_FLAG_KEY"}   # confirm it doesn't already exist
call create-feature-flag { ... }     # → returns Prod flag id (e.g. 690879)

# 4. Switch back to Test if you'll do more dev work
call switch-project {"projectId": 225935}
```

Same pattern applies to **updates** (e.g. adding a release condition or renaming): you must run `update-feature-flag` against the Prod id AND the Test id, with a `switch-project` between them. The flag IDs differ between projects — keep a note of both. Same for **deletes**: delete in both projects when removing a flag.

If you only need the change in one project (e.g. a temporary smoke-test rollout in Test, or a Prod-only hotfix), say so explicitly so the next person doesn't assume the two are in sync.

## MCP protocol (mandatory order)

The PostHog MCP exposes a single entry point — `mcp__posthog__exec` — that wraps a CLI-style dispatcher. **Every tool call must follow this exact order:**

1. **Discover** the tool name — `search <regex>` (preferred) or `tools` (full list).
2. **Inspect schema** — `info <tool_name>`. Required before every `call`, even if you've seen the tool before. Schemas drift.
3. **Drill complex fields** — if `info` returned `hint` markers on any field you need to populate, run `schema <tool_name> <field_path>` before constructing the value.
4. **Execute** — `call <tool_name> <json_input>`.

Skipping `info` and guessing parameters is the #1 cause of `Validation error` / `Unknown tool` failures in this MCP.

## Confirm before write operations

PostHog write operations against `Scratch - Prod` and `Scratch - Test` affect shared state visible to other people, and the MCP has no built-in undo or "are you sure?" guardrail. **Before running any write operation, lay out the plan and wait for the user to confirm.**

- **Always confirm:** `create-feature-flag`, `update-feature-flag`, `delete-feature-flag`, `insight-create`, `insight-update`, `insight-delete`, `dashboard-create`, `dashboard-update`, `dashboard-delete`, `survey-create`/`-update`/`-delete`, and any other `*-create`/`*-update`/`*-delete` / `*-launch` / `*-archive` tool.
- **No confirmation needed for:** discovery and read-only calls — `tools`, `search`, `info`, `schema`, `feature-flag-get-all`, `feature-flag-get-definition`, `project-get`, `dashboards-get-all`, `insight-get`, `read-data-schema`, `query-trends` (and other `query-*` tools when run without `insight-create` afterward), etc.
- **`switch-project` is a borderline case.** It doesn't write to PostHog, but it changes which project subsequent writes will hit, so changing projects mid-session is worth a one-line announcement (e.g. "switching to Prod (214130) to mirror the flag"). No need for an explicit "OK?" prompt.

### The plan format

For any write op (or batch of write ops), present the plan as a short list before executing, with these items per operation:

1. **Which project** — `Scratch - Prod (214130)` or `Scratch - Test (225935)`, by name and id.
2. **Which tool** — e.g. `create-feature-flag`, `update-feature-flag`.
3. **The key fields** — flag key + key release-condition details, or insight name + breakdown property, etc. Don't paste the full JSON; show what matters for someone scanning to catch a mistake.
4. **The expected effect** — "creates a disabled flag with no release conditions" / "matches 100% of users in Prod" / "renames the flag, history preserved".

Then ask "OK to run?" or equivalent and wait for a response.

For **two-project workflows** (create in Test → verify → create in Prod), present both as a single plan up front so the user sees the whole sequence. You'll still pause between Test and Prod for the smoke-test step, but the user only has to read the plan once.

### When trivial writes are OK without an explicit prompt

A write is "trivial enough to run without a prompt" only when **all** of these hold:

- The user has just explicitly asked for this exact write in the same turn (e.g. "now mirror that flag to Prod" → no need to re-summarize; just announce and run).
- It's a single call (not a sequence).
- It's clearly reversible if wrong — e.g. a Test-only write that you and the user are actively iterating on.
- It's not a `delete-*` against Prod.

When in doubt, present the plan. The cost of an extra confirmation is one message; the cost of an unwanted Prod write can be much higher.

## Section 1 — Feature flags

### Naming and configuration conventions (codebase rules)

These come from `server/src/experiments/flags.ts` and the bug-report flag precedent — follow them so the new flag integrates cleanly with the existing typed-flag infrastructure.

- **Key format:** `UPPER_SNAKE_CASE`, e.g. `ENABLE_CREATE_BUG_REPORT`, `DISABLE_GENERIC_CONNECTOR`.
- **`ENABLE_X` vs `DISABLE_X`:**
  - **`ENABLE_X`** is opt-in/dark-launch. Default = false (everyone disabled until added to a release group). Use when the feature is new and being rolled out to specific users. Matches the pattern of `ENABLE_CREATE_BUG_REPORT`.
  - **`DISABLE_X`** is a kill switch on an already-live feature. Default = false (everyone gets the feature). Setting `true` for a user disables it for them. Operationally cleaner than `ENABLE_X` for "turn it off for these problem users" — see the discussion in `server/src/experiments/flags.ts` comments.
  - For an already-live feature you want to be able to disable per-user, prefer `DISABLE_X` over `ENABLE_X`. The opposite mapping (`ENABLE_X` with 100% rollout, plus property-filtered exclusions) is awkward because PostHog has no native "exclude" condition.
- **Do NOT enable "Persist flag across authentication steps"** in the PostHog UI. The codebase comment explicitly calls this out: flags with that setting are hidden from the SDK. The MCP `create-feature-flag` and `update-feature-flag` calls do not set it, so leave it alone unless you know what you're doing.
- **Active toggle vs. release conditions:** the flag-level "Active" toggle in PostHog only controls whether PostHog evaluates the flag at all. To kill a feature, leave Active ON and use release conditions (set rollout to 0% or scope away). Toggling Active off causes PostHog to return `null`, which falls back to the `defaultValue` in server code — usually `false`, but check the call site.

### Wiring a new flag into the codebase

For any flag the server reads, code changes are required in addition to the PostHog UI/MCP creation. A user-scoped boolean flag needs:

1. **`server/src/experiments/flags.ts`**
   - Add the key to the `UserFlag` enum.
   - If the flag should be visible to the client, add it to the `ClientUserFlags` map with the data type (`'boolean'`, `'string'`, `'number'`, `'array'`).
2. **`client/src/types/server-entities/users.ts`** (only if exposed to client) — add the property to the `UserExperimentFlags` interface so the typed `isExperimentEnabled('FLAG_NAME', user)` check compiles.
3. **Server consumer** — use `ExperimentsService.getBooleanFlag(UserFlag.X, defaultValue, user)` for ad-hoc reads, or wrap in a domain-specific helper (e.g. `isGenericConnectorEnabledForUser(userId)` in `experiments.service.ts`). For kill switches, prefer a `fail-closed` default (`defaultValue = false`) so PostHog outages don't accidentally enable a disabled feature.
4. **Client consumer** — `import { isExperimentEnabled } from '@/types/server-entities/users'` then `isExperimentEnabled('FLAG_NAME', user)`. Reads from `user.experimentalFlags` populated by the `/users/current` endpoint.

### Recipe: create a flag

```
# 1. Confirm target project. Switch to Test for smoke-testing first.
posthog:exec({ "command": "call switch-project {\"projectId\": 225935}" })

# 2. Check it doesn't already exist.
posthog:exec({ "command": "call feature-flag-get-all {\"search\": \"YOUR_FLAG_KEY\"}" })

# 3. Schema check.
posthog:exec({ "command": "info create-feature-flag" })

# 4. Create. Leaving `filters` unset → no release conditions → flag returns false
#    for everyone (kill switch off / opt-in not yet granted). Set release
#    conditions later via the UI or update-feature-flag.
posthog:exec({ "command": "call create-feature-flag {
  \"key\": \"YOUR_FLAG_KEY\",
  \"name\": \"<one-line human description ending with default behavior>\",
  \"active\": true
}" })
```

Save the returned `id` and the `_posthogUrl` — you'll need the id for `update-feature-flag` / `delete-feature-flag`. The dashboard URL pattern is `https://us.posthog.com/project/<project_id>/feature_flags/<flag_id>`.

**After creating in Test and verifying the wiring works, repeat steps 1-4 in Prod (`switch-project` to `214130`).** Don't skip Prod creation — server code reads from `POSTHOG_API_KEY` (project-scoped), so the flag needs to exist in each project the code runs against.

### Recipe: update / add release conditions

```
posthog:exec({ "command": "info update-feature-flag" })

# Enable for everyone (kill switch in DISABLE_X = ON for all, or feature gate
# in ENABLE_X = ON for all).
posthog:exec({ "command": "call update-feature-flag {
  \"id\": <flag_id>,
  \"filters\": {
    \"groups\": [{ \"properties\": [], \"rollout_percentage\": 100 }]
  }
}" })

# Target a specific user by email.
posthog:exec({ "command": "call update-feature-flag {
  \"id\": <flag_id>,
  \"filters\": {
    \"groups\": [{
      \"properties\": [
        {\"key\": \"email\", \"type\": \"person\", \"operator\": \"exact\", \"value\": \"someone@example.com\"}
      ],
      \"rollout_percentage\": 100
    }]
  }
}" })
```

`update-feature-flag` is idempotent and supports renaming via `key` — the id stays stable, so dashboard URLs and history survive renames.

### Recipe: delete

```
posthog:exec({ "command": "info delete-feature-flag" })
posthog:exec({ "command": "call delete-feature-flag {\"id\": <flag_id>}" })
```

Delete in both Test and Prod when removing a flag. Always remove the corresponding code references (`UserFlag` enum entry, `ClientUserFlags` map entry, `UserExperimentFlags` interface field, any helper methods) in the same PR — orphaned enum values are silent bugs waiting to happen.

### Propagation timing

- `posthog-node` polls flag definitions on an interval (~30s default). After a release-condition change, expect up to ~30s before all server instances see the new value.
- The client refreshes `/users/current` on a 5-minute SWR interval (`useScratchpadUser.ts`). A hard refresh skips the wait.
- These two layers compound, so "I just toggled the flag" delays of up to ~5 minutes are normal without intervention.

## Section 2 — Adding metrics on top of existing events

### Two-line summary on cost

PostHog bills per **event count**, not per property. **Adding new properties to events that already fire costs nothing.** Adding new events does. So the default playbook is "enrich existing events" before "create new event."

### Existing tracked events

See `server/src/posthog/posthog.service.ts` for the full list — `PostHogService` is the only place server-side analytics events are emitted. The relevant ones for connector/data-pull metrics:

- `connector_created`, `connector_updated`, `connector_deleted`, `connector_reauthorized` — per-connection lifecycle.
- `pull_completed` — fires once per pull job, with `result: 'success' | 'failure'`. No separate `pull_failed` event; failures use the same event with the `result` field. **Early aborts (e.g. exceptions before the tracking call) do NOT fire `pull_completed` at all.**
- `pull_tables_for_data_source` — table discovery, separate from a full pull.
- `pull_files` — single-file pull (CLI niche path), separate handler in `pull-files.job.ts`.
- `sync_completed`, `publish_completed`, etc. — see the file for the full enum.

### Property conventions

- **`camelCase` property names** — match the existing convention. `connectorService`, `dataSourceId`, `apiDomain`, etc.
- **Optional vs. required on the signature:**
  - When a property is always derivable in every caller, make it required for type safety.
  - When **multiple call sites exist for the same `track*` method** and some can't supply the property without significant refactoring, make it optional and document why (e.g. `pull_completed` is called from both `pull-linked-folder-files.job.ts` and `pull-files.job.ts`; the latter doesn't currently have the connector account loaded). Optional keeps the change backwards-compatible at the type level.
- **Spread conditionally for optional values** so PostHog doesn't store an explicit `undefined`:
  ```ts
  this.captureEvent(EventName.X, actor, {
    ...alwaysSet,
    ...(maybeUndefined && { propertyName: maybeUndefined }),
  });
  ```

### Recipe: enrich an existing event

Example — adding the `apiDomain` (third-party API domain) property to `connector_created` and `pull_completed`, populated only when the connector is `GENERIC_API`:

1. **Add a tiny extraction helper** (if domain parsing) — `extractApiDomain(url)` lives in `server/src/utils/urls.ts`. Use `new URL(url).hostname` stripped of leading `www.`. Returns `undefined` on parse failure.
2. **Extend the `track*` method signature** in `posthog.service.ts` — add the property to the `properties` type, mark optional if there's an existing alternate caller, conditionally spread into the captured event.
3. **Populate at the call site** — guard on the relevant condition (`if (service === ServiceConst.GENERIC_API)`), extract the value, pass it in.
4. **For jobs**, computing the property may need to happen earlier in the handler (where the relevant DB objects are in scope) and be piped through to where `trackPullCompleted` is called. Example: in `pull-linked-folder-files.job.ts`, the `connectorAccount` is loaded in `run()`, but `trackPullCompleted` lives in `postProcess()` — extend `postProcess`'s params type with the new optional fields and pass them through. Don't re-load the same row in `postProcess` just to track.

### Recipe: build an insight / dashboard for the new property via MCP

Once events with the new property are flowing (typically ~24h of data), build the visualization:

1. `posthog:exec({ "command": "search query-trends" })` — locate the trend query tool.
2. `posthog:exec({ "command": "info query-trends" })` — schema check. The schema is large; expect `hint` markers.
3. `posthog:exec({ "command": "schema query-trends series" })` — drill into the `series` field structure (mandatory before populating it).
4. **Verify the event exists** in collected data: `call read-data-schema {"query": {"kind": "events"}}` — canonical-looking names like `pull_completed` still need confirmation per project.
5. Construct the `query-trends` call with a property breakdown on the new field. Filter to `connectorService = '<TYPE>'` if you want to scope to a specific connector.
6. Save as an insight (`insight-create`) and assemble into a dashboard (`dashboard-create`) if multiple metrics belong together.

Detailed schema construction is non-obvious — rely on the `info` / `schema` drill-downs rather than guessing.

### Filtering out internal users

Admin/staff event traffic can skew breakdowns. We don't currently identify admins as a PostHog person property, so filtering is a future enhancement. Two paths when you get there:

- **Server-side skip:** in the `track*` method or the call site, early-return when `actor.isAdmin === true`. Stops the event from being emitted at all.
- **Person-property filter:** call `posthog.identify(...)` with `isAdmin: true` for admin users, then filter `where person.isAdmin = false` in queries. More flexible (you can toggle the filter per-insight) but requires the identify call to happen at login.

## Important guidelines

- **Confirm `posthog-node` propagation lag.** ~30s for server flag changes to take effect after `update-feature-flag`. The MCP returns success the instant the API responds, but the running server hasn't repolled yet.
- **Make changes in Test first.** The MCP doesn't have any "are you sure?" guardrails. `delete-feature-flag` against Prod is final.
- **`info` is not optional.** Tool schemas drift between PostHog releases. Always re-run `info <tool>` before `call <tool>` — see "MCP protocol" above.
- **Skill scope.** This skill covers the MCP-driven workflow. Code changes (adding to `UserFlag`, `ClientUserFlags`, `UserExperimentFlags`, `PostHogService` signatures) follow the project's normal Edit/build/lint flow.
