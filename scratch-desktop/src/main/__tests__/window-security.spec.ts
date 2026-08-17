import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSecureWebPreferences } from '../window-security';

/**
 * Regression guard for the BrowserWindow renderer-isolation settings (Oneleet SCR-014 / DEV-11009
 * for the sandbox; SCR-006 / DEV-11001 for contextIsolation + nodeIntegration). These webPreferences
 * are a security control, not a preference: `sandbox: false`, `contextIsolation: false`, or
 * `nodeIntegration: true` would each widen the blast radius of a renderer-side bug. This spec fails
 * the build if a future edit loosens them.
 *
 * Like electron-fuses.spec.ts, it asserts the *config* (the factory `createWindow` calls), not a
 * packaged binary — the sandbox is a runtime flag with no static artifact to read. The source-text
 * checks at the bottom keep the guard honest about index.ts's real call site.
 */

const desktopPackageDir = process.cwd();
const preloadPath = '/abs/out/preload/index.js';

describe('buildSecureWebPreferences', () => {
  it('enables the OS-level renderer sandbox (SCR-014 / DEV-11009), in dev and packaged builds alike', () => {
    expect(buildSecureWebPreferences({ preloadPath, isDev: false }).sandbox).toBe(true);
    expect(buildSecureWebPreferences({ preloadPath, isDev: true }).sandbox).toBe(true);
  });

  it('pins contextIsolation on and nodeIntegration off (SCR-006 / DEV-11001)', () => {
    const prefs = buildSecureWebPreferences({ preloadPath, isDev: false });
    expect(prefs.contextIsolation).toBe(true);
    expect(prefs.nodeIntegration).toBe(false);
  });

  it('passes the preload path through unchanged', () => {
    expect(buildSecureWebPreferences({ preloadPath, isDev: false }).preload).toBe(preloadPath);
  });

  it('enables webSecurity in packaged builds and disables it only in dev', () => {
    // Off in dev so the localhost:5173 renderer can reach the prod API without CORS; it must be on
    // in every packaged build (isDev false), which is the state that actually ships to users.
    expect(buildSecureWebPreferences({ preloadPath, isDev: false }).webSecurity).toBe(true);
    expect(buildSecureWebPreferences({ preloadPath, isDev: true }).webSecurity).toBe(false);
  });
});

describe('createWindow (src/main/index.ts) uses the guarded factory', () => {
  const indexSource = readFileSync(path.join(desktopPackageDir, 'src', 'main', 'index.ts'), 'utf8');

  it('builds webPreferences via buildSecureWebPreferences rather than an inline object', () => {
    expect(indexSource).toContain('buildSecureWebPreferences({');
  });

  it('contains no literal `sandbox: false` (re-inlining an insecure webPreferences block trips this)', () => {
    expect(indexSource).not.toMatch(/sandbox:\s*false/);
  });
});
