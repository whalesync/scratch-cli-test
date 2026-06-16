#!/usr/bin/env node
/*
 * postinstall: rebuild native node modules against Electron's ABI
 * (electron-builder's `install-app-deps`).
 *
 * Invoked via `node` + `require.resolve` rather than the `electron-builder`
 * bin so it survives yarn-1 symlinked workspaces on Windows. There, the nested
 * `node_modules/.bin/electron-builder.cmd` shim hard-codes a RELATIVE target
 * (`%~dp0\..\..\..\node_modules\electron-builder\cli.js`) computed for the
 * package's REAL location — but yarn runs the postinstall through the
 * `node_modules/<pkg>` SYMLINK, one level deeper, so the `..\..\..` lands at
 * `<root>/node_modules` instead of `<root>` and resolves to a bogus doubled
 * `node_modules/node_modules/electron-builder/cli.js`, failing the install.
 *
 * `require.resolve` walks the real module graph and finds the hoisted
 * electron-builder correctly from either the real or the symlinked cwd, so this
 * works identically on macOS, Linux, and Windows.
 */

'use strict';

const { execFileSync } = require('node:child_process');

const cliPath = require.resolve('electron-builder/cli.js');
execFileSync(process.execPath, [cliPath, 'install-app-deps'], { stdio: 'inherit' });
