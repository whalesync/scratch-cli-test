export interface LocalWorkspaceEntry {
  id: string;
  path: string;
}

export async function listLocalWorkspaces(): Promise<LocalWorkspaceEntry[]> {
  return window.scratchDesktop.getWorkspacesRegistry();
}
