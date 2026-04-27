/** Compact payloads forwarded from the main-process autoUpdater to the renderer. */
export type UpdaterEvent =
  | { type: 'checking-for-update'; manual: boolean }
  | {
      type: 'update-available';
      manual: boolean;
      version: string;
      releaseDate?: string;
      releaseNotes?: string | null;
    }
  | {
      type: 'update-not-available';
      manual: boolean;
      version: string;
    }
  | {
      type: 'download-progress';
      manual: boolean;
      percent: number;
      bytesPerSecond: number;
      transferred: number;
      total: number;
    }
  | {
      type: 'update-downloaded';
      manual: boolean;
      version: string;
      releaseDate?: string;
      releaseNotes?: string | null;
    }
  | {
      type: 'error';
      manual: boolean;
      message: string;
    };

export const UPDATER_EVENT_CHANNEL = 'updater:event';
