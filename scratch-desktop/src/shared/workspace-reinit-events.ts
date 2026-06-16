/**
 * Broadcast from main process to all renderer windows when any `scratchmd` call
 * refuses with the structured `workspace_needs_reinit` payload (a workspace
 * created on an older Scratch layout that the current CLI no longer supports).
 *
 * The renderer subscribes once at the workspace level and surfaces a
 * "Reinitialize workspace" modal regardless of which call triggered the
 * refusal — this avoids per-handler error plumbing.
 */
export interface WorkspaceNeedsReinitEvent {
  workspacePath: string;
  affectedConnections: string[];
  /**
   * Why the CLI asked for a re-clone. `'old_layout_pre_slice_f'` is the legacy
   * multi-worktree layout; `'structure_changed'` (DEV-9698) is a server-side
   * folder restructure that left this clone stale. Left as a widenable string
   * so a new CLI reason never breaks an older renderer. The renderer tailors
   * its copy to the reason.
   */
  reason?: string;
  /** Human-readable next step from the CLI payload, surfaced verbatim when present. */
  recommendation?: string;
}

export const WORKSPACE_NEEDS_REINIT_CHANNEL = 'scratch:workspace-needs-reinit';
