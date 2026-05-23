# Post-Publish Refresh Policy

After a publish completes (all per-connection plan-job + run-job pairs reach a terminal state), the desktop calls `scratchmd files download` once to advance the local `refs/heads/main` to match the server. Call site: [`PublishChangesModal.tsx`](../src/renderer/src/pages/workspace/PublishChangesModal.tsx) (`refreshLocal` inside the all-terminal `useEffect`).

The policy is **single attempt, silent failure**. This document captures why.

## Behavior

| Outcome                   | What happens                                                                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `files download` succeeds | `onDataRefresh()` fires → UI re-fetches folder data with the advanced HEAD.                                                                                                                                                               |
| `files download` fails    | One `console.debug('Post-publish pull failed:', err)`. No toast, no error banner, no retry. Modal still transitions to `'complete'` or `'error'` based on per-connection publish outcomes — refresh failure does not gate the transition. |

The fire-and-forget shape is deliberate: `void refreshLocal()` runs alongside the mode transition, so the user is never blocked behind the refresh.

## Why no retry

Two cases where `files download` would fail:

1. **Transient network failure.** The next manual pull, the next publish dance, or workspace re-open all run `files download` again — those existing paths recover the state automatically. Retrying here would mostly just delay the user's modal close.
2. **Workspace-level error** (lock contention, corrupted `accepted-patches.json`, unreviewed edits introduced in the publish window). Retrying without user attention masks the real issue; the user will see it on their next interaction with the workspace, where the error has somewhere to surface.

A failed refresh leaves the workspace in a recoverable state: "local `main` is one publish behind server." The patches were uploaded server-side and applied; the server is authoritative. Nothing is lost.

## What this is NOT

- **Not a guarantee that the local HEAD has advanced when the modal closes.** Callers downstream of `onDataRefresh` cannot assume `refs/heads/main` is current. Anything that depends on the published state should call its own `pullWorkspaceChanges` or read from the server.
- **Not a data-integrity safeguard.** The CLI's `reconcile_accepted_after_publish` (run as part of `files download`) is what actually re-anchors `accepted-patches.json` against the post-publish `main`. If this refresh silently fails, the next pull does the same work — no data drifts in the meantime, but the local `accepted-patches.json` may briefly look like the publish "didn't happen" until the next pull lands.

## Future work

If telemetry shows refresh failures clustering around specific causes, surface them via a non-blocking toast instead of `console.debug`. The richer fix — having the server push a HEAD-advance signal so the client doesn't have to poll/fetch at all — is tracked under CEO follow-up F9 in [`docs/plans/2026-05-17-simplify-local-workspace-architecture.md`](../../docs/plans/2026-05-17-simplify-local-workspace-architecture.md) ("Publish-then-fetch failure → server-driven HEAD-advance signal").

## Related

- [DEV-10144 E4](../../docs/plans/2026-05-17-simplify-local-workspace-architecture.md#eng-review-follow-ups) — the follow-up that drove this doc.
- [CEO Review Finding 1.6](../../docs/plans/2026-05-17-simplify-local-workspace-architecture.md) — the original data-flow shadow-path observation.
- `reconcile_accepted_after_publish` in [`scratch-git-2/src/cli/commands/files.rs`](../../scratch-git-2/src/cli/commands/files.rs) — the CLI-side post-publish reconciliation that this refresh transitively triggers.
