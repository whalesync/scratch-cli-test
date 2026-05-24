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
}

export const WORKSPACE_NEEDS_REINIT_CHANNEL = 'scratch:workspace-needs-reinit';
