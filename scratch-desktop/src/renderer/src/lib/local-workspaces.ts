export interface LocalWorkspaceEntry {
  id: string;
  path: string;
  /** Total record files on disk (data leaf folders); 0 if the path could not be read. */
  fileCount: number;
}

export async function listLocalWorkspaces(): Promise<LocalWorkspaceEntry[]> {
  return window.scratchDesktop.getWorkspacesRegistry();
}
