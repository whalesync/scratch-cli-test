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
      /** Version offered by the update feed (the latest published release on the channel). */
      version: string;
      /**
       * The version actually installed and running right now (`app.getVersion()`). This is what
       * the "You're up to date" toast must show — never `version`, which is the feed's latest and
       * can sit BELOW the running version when the channel is wedged (e.g. a bad low-semver release
       * shadowing "latest"), producing a misleading "Running version 0.1.1" on a 1.0.104 app.
       */
      runningVersion: string;
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
      /**
       * 'check' = failed while talking to the update feed (DNS, 4xx, no network at all).
       * 'download' = failed after an update was found, while downloading the artifact.
       * 'install' = failed applying a downloaded update (the "Restart & install" handoff; on
       * macOS this is Squirrel.Mac fetching the staged artifact over its loopback proxy).
       * Renderer policy: 'check' errors are shown only for manual checks (background
       * check noise on flaky networks is intentional). 'download' and 'install' errors are
       * always shown — the user has a pending update and deserves to know it didn't land.
       */
      phase: 'check' | 'download' | 'install';
      message: string;
    };

export const UPDATER_EVENT_CHANNEL = 'updater:event';
