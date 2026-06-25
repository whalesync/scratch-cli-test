/**
 * Compact payload forwarded from the main-process auto-download scheduler
 * (DEV-10470) to the renderer after each scheduled background re-download of a
 * workspace. The renderer (WorkspacePage) listens for this so that when the
 * currently-open workspace was refreshed under the user it can re-read the grid
 * and surface a notification — without the user having to click "Re-download".
 */
export interface AutoDownloadCompletedEvent {
  /** The workbook (server) id of the workspace that was re-downloaded. */
  workbookId: string;
  /** Absolute local path of the workspace that was re-downloaded. */
  workspacePath: string;
  /**
   * Outcome of the background pull. Mirrors `DownloadWorkspaceResult.status`
   * with an extra `error` branch for a thrown failure (network/auth/etc.).
   */
  status: 'downloaded' | 'up_to_date' | 'downloaded_with_stashed_conflicts' | 'blocked_conflict' | 'error';
  /** Created + updated + deleted + merged files. Zero when nothing changed. */
  filesChanged: number;
  /** Local edits that conflicted and were stashed to `unreviewed-changes.json`. */
  conflictCount: number;
  /** Present only when `status === 'error'`: the failure message. */
  message?: string;
}

export const AUTO_DOWNLOAD_COMPLETED_CHANNEL = 'auto-download:completed';
