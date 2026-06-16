#!/usr/bin/env node
/*
 * postinstall: run `prisma generate`.
 *
 * Invoked via `node` + module resolution rather than the `prisma` bin so it
 * survives yarn-1 symlinked workspaces on Windows. There, `yarn install` runs
 * each package's postinstall through the `node_modules/<pkg>` SYMLINK, but the
 * nested `node_modules/.bin/prisma.cmd` shim hard-codes a RELATIVE target
 * (`%~dp0\..\..\..\node_modules\prisma\build\index.js`) computed for the
 * package's REAL location. One extra symlink level makes `..\..\..` land at
 * `<root>/node_modules` instead of `<root>`, resolving to a bogus doubled
 * `node_modules/node_modules/prisma/build/index.js` and failing the install.
 *
 * Resolving prisma's own package.json and reading its `bin` entry walks the
 * real module graph, so this finds the hoisted prisma CLI correctly from either
 * the real or the symlinked cwd — identical behavior on macOS, Linux, Windows.
 */

'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const prismaPackageJsonPath = require.resolve('prisma/package.json');
const prismaPackageDir = path.dirname(prismaPackageJsonPath);
const prismaBinField = require(prismaPackageJsonPath).bin;
const prismaBinRelativePath = typeof prismaBinField === 'string' ? prismaBinField : prismaBinField.prisma;
const prismaCliEntryPath = path.join(prismaPackageDir, prismaBinRelativePath);

execFileSync(process.execPath, [prismaCliEntryPath, 'generate'], { stdio: 'inherit' });
