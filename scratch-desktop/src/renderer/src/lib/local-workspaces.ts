export type CloudSyncProvider = 'icloud' | 'dropbox' | 'onedrive' | 'googledrive' | 'box' | 'cloudstorage-other';

export interface CloudSyncWarning {
  provider: CloudSyncProvider;
  providerLabel: string;
  evidencePath: string;
}

export interface LocalWorkspaceEntry {
  id: string;
  path: string;
  /** Total record files on disk (data leaf folders); 0 if the path could not be read. */
  fileCount: number;
  /** Set when the workspace path resolves under a cloud-sync root (iCloud/Dropbox/OneDrive/etc.). */
  cloudSyncWarning: CloudSyncWarning | null;
}

export async function listLocalWorkspaces(): Promise<LocalWorkspaceEntry[]> {
  return window.scratchDesktop.getWorkspacesRegistry();
}
