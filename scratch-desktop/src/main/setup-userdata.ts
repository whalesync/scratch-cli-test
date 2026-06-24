import { app } from 'electron';
import { join } from 'path';

// Automated end-to-end tests (Playwright `_electron`) point each run at a throwaway
// userData directory so they get an isolated, deterministic profile — no shared dev/prod
// auth tokens or cookies leaking in (and no test polluting the developer's own dev app).
// Honored before the dev-suffix fallback below, in both packaged and unpackaged builds.
const explicitUserDataDirectoryForTests = process.env.SCRATCH_DESKTOP_USER_DATA_DIR;
if (explicitUserDataDirectoryForTests) {
  app.setPath('userData', explicitUserDataDirectoryForTests);
} else if (!app.isPackaged) {
  // Unpackaged (dev) builds get their own userData directory so they don't share
  // auth tokens, cookies, or other Electron state with the installed prod app.
  app.setPath('userData', join(app.getPath('appData'), `${app.getName()}-dev`));
}
