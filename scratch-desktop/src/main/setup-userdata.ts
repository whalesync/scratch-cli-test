import { app } from 'electron';
import { join } from 'path';

// Automated end-to-end tests (Playwright `_electron`) point each run at a throwaway
// userData directory so they get an isolated, deterministic profile — no shared dev/prod
// auth tokens or cookies leaking in (and no test polluting the developer's own dev app).
// Honored before the dev-suffix fallback below, in both packaged and unpackaged builds.
// Tests can also relocate the "home" dir so the global workspace registry
// (`~/.scratchmd/workspaces.yaml`, read via `app.getPath('home')`) is isolated
// from the developer's real one. On macOS `app.getPath('home')` ignores `$HOME`
// (it's a native lookup), so a launch-env `HOME` override is not enough — this
// seam is the only way an `_electron` test can register a throwaway workspace
// without polluting the real registry. Honored only in unpackaged builds,
// mirroring the userData seam below.
const explicitHomeDirectoryForTests = process.env.SCRATCH_DESKTOP_HOME_DIR;
if (explicitHomeDirectoryForTests && !app.isPackaged) {
  app.setPath('home', explicitHomeDirectoryForTests);
}

const explicitUserDataDirectoryForTests = process.env.SCRATCH_DESKTOP_USER_DATA_DIR;
if (explicitUserDataDirectoryForTests) {
  app.setPath('userData', explicitUserDataDirectoryForTests);
} else if (!app.isPackaged) {
  // Unpackaged (dev) builds get their own userData directory so they don't share
  // auth tokens, cookies, or other Electron state with the installed prod app.
  app.setPath('userData', join(app.getPath('appData'), `${app.getName()}-dev`));
}
