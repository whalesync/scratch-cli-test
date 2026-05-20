/* Hand-maintained for slice H.2 — napi-rs v3 + napi-derive `type-def` did
 * not produce output in our workspace setup. Regenerate / replace with
 * autogen in H.3 if the autogen story improves. Keep this file in sync with
 * `src/lib.rs` exports.
 */

export interface ReviewOpResult {
  workspacePath: string;
  patchesChanged: boolean;
  workingChanged: boolean;
  /** Coarse "what happened" tag. Pattern-match on this in the renderer. */
  effect: 'NoOp' | 'PatchUpserted' | 'PatchDropped' | 'WorkingRestored';
}

/**
 * Accept `localValue` for `field` on `recordRelPath` under
 * `connectionDirName` inside `workspaceDir`. Updates
 * `accepted-patches.json` so the field's approved value matches
 * `localValue`.
 *
 * Errors come through as `Error` instances whose `message` is prefixed with
 * a stable code: `"<CODE>: <human description>"`. Known codes:
 *
 *   - `LOCK_BUSY`             — workspace lock held by another process
 *   - `WORKSPACE_NOT_FOUND`   — no `workspace.yaml` at `workspaceDir`
 *   - `UNKNOWN_CONNECTION`    — `connectionDirName` not in `workspace.yaml`
 *   - `NOT_A_RECORD_PATH`     — `recordRelPath` isn't a data record path
 *   - `INVALID_JSON`          — main blob or working file isn't parseable JSON
 *   - `INTERNAL`              — any other I/O or unexpected error
 *
 * Why not `err.code`: napi-rs 2.x reserves `err.code` for napi `Status` and
 * doesn't let Rust override it. The desktop shim parses the message prefix.
 */
export function acceptField(
  workspaceDir: string,
  connectionDirName: string,
  recordRelPath: string,
  field: string,
  localValue: unknown,
): Promise<ReviewOpResult>;
