/**
 * Security-critical BrowserWindow `webPreferences`, factored out of `index.ts` so a regression
 * spec (`window-security.spec.ts`) can assert them without importing the main-process entrypoint
 * (which runs heavy load-time side effects). This mirrors how the electron-fuses / entitlements
 * guards assert a config value against a single source of truth.
 *
 * `sandbox: true` enables Electron's OS-level renderer sandbox (DEV-11009 / Oneleet SCR-014). The
 * preload is sandbox-safe: it imports only `electron` (`contextBridge`/`ipcRenderer`) plus inlined
 * local constant modules, uses only the sandboxed-preload `process` subset (`platform`,
 * `contextIsolated`), and does all filesystem / path / child-process work in the main process
 * behind IPC. So flipping the sandbox on requires no preload change. Any FUTURE preload edit that
 * reaches for `fs`/`path`/a Node-only module must instead go through a main-process IPC handler.
 *
 * `contextIsolation`/`nodeIntegration` are pinned explicitly (not left at Electron's defaults) so a
 * future edit can't silently regress the renderer's isolation. `webSecurity` is intentionally left
 * off in dev only — see the field comment below.
 */

export interface SecureWebPreferencesInput {
  /** Absolute path to the built preload script. */
  preloadPath: string;
  /** `is.dev` from @electron-toolkit/utils — true only under `electron-vite dev`. */
  isDev: boolean;
}

export function buildSecureWebPreferences({ preloadPath, isDev }: SecureWebPreferencesInput): Electron.WebPreferences {
  return {
    preload: preloadPath,
    // OS-level renderer sandbox — DEV-11009 / Oneleet SCR-014. Keep the preload sandbox-safe (see
    // the module docstring) or this will break renderer↔main IPC.
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    // Disable web security in dev only, so the renderer (served from localhost:5173) can reach the
    // production API without CORS blocking preflight requests. It is always on in a packaged build.
    webSecurity: !isDev,
  };
}
