/**
 * Error bodies Scratch returns when a Whalesync team's Live Export access, which Whalesync sets, doesn't allow a Live
 * Export action (DEV-12983). Each body carries a stable `error` code to branch on and a `message` written for the
 * person who acted.
 */
export const LIVE_EXPORT_PAUSED_ERROR = 'LIVE_EXPORT_PAUSED';

/** 403 body when a Live Export run is refused because Whalesync has paused the team's Live Exports. */
export interface LiveExportPausedError {
  error: typeof LIVE_EXPORT_PAUSED_ERROR;
  message: string;
}
