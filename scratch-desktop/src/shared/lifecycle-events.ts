/** Channels for the main↔renderer handshake that lets the renderer flush analytics before quit. */
export const APP_WILL_QUIT_CHANNEL = 'app:will-quit';
export const APP_QUIT_CONFIRMED_CHANNEL = 'app:quit-confirmed';

export interface AppWillQuitPayload {
  sessionDurationMs: number;
}
