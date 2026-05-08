import { app } from 'electron';
import { join } from 'path';

// Unpackaged (dev) builds get their own userData directory so they don't share
// auth tokens, cookies, or other Electron state with the installed prod app.
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), `${app.getName()}-dev`));
}
