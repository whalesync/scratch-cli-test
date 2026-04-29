#!/usr/bin/env node
/**
 * Prints an absolute path to a .p12 for electron-builder's CSC_LINK.
 * Reads process.env.CSC_LINK (file path, ~/path, or base64 with optional data:…;base64, prefix).
 * If decoding was required, writes a temp file in os.tmpdir() and prints that path.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const raw = process.env.CSC_LINK;
if (raw == null || String(raw).trim() === '') {
  process.stderr.write('ERROR: CSC_LINK is empty in the environment passed to this script.\n');
  process.exit(1);
}

const link = String(raw).trim().replace(/\r/g, '');

function tryRealFile(p) {
  try {
    if (!p) {
      return null;
    }
    const s = fs.statSync(p);
    if (!s.isFile()) {
      return null;
    }
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

if (link.startsWith('data:')) {
  const m = /base64,(.*)$/s.exec(link);
  if (!m) {
    process.stderr.write('ERROR: data: URL without base64 payload\n');
    process.exit(1);
  }
  const out = path.join(
    os.tmpdir(),
    `scratch-csc-${crypto.randomBytes(8).toString('hex')}.p12`
  );
  fs.writeFileSync(out, Buffer.from(m[1].replace(/\s/g, ''), 'base64'), { mode: 0o600 });
  process.stdout.write(out);
  process.exit(0);
}

const scratchDesktop = process.env.SCRATCH_DESKTOP;

let p = tryRealFile(link);
if (p) {
  process.stdout.write(p);
  process.exit(0);
}

if (link.startsWith('~/')) {
  p = tryRealFile(path.join(os.homedir(), link.slice(2)));
  if (p) {
    process.stdout.write(p);
    process.exit(0);
  }
}

p = tryRealFile(path.resolve(process.cwd(), link));
if (p) {
  process.stdout.write(p);
  process.exit(0);
}

if (scratchDesktop) {
  p = tryRealFile(path.resolve(scratchDesktop, link));
  if (p) {
    process.stdout.write(p);
    process.exit(0);
  }
  p = tryRealFile(path.resolve(scratchDesktop, link.replace(/^\.\//, '')));
  if (p) {
    process.stdout.write(p);
    process.exit(0);
  }
}

if (link.startsWith('file://')) {
  const f = link.slice('file://'.length);
  p = tryRealFile(f);
  if (p) {
    process.stdout.write(p);
    process.exit(0);
  }
}

if (link.startsWith('https://') || link.startsWith('http://')) {
  process.stdout.write(link);
  process.exit(0);
}

const b64 = link.replace(/\s/g, '');
if (b64.length < 100 || !/^[A-Za-z0-9+/=]+$/.test(b64)) {
  process.stderr.write(
    'ERROR: CSC_LINK is not a readable .p12 path and does not look like a base64 payload.\n'
  );
  process.exit(1);
}

const out = path.join(
  os.tmpdir(),
  `scratch-csc-${crypto.randomBytes(8).toString('hex')}.p12`
);
fs.writeFileSync(out, Buffer.from(b64, 'base64'), { mode: 0o600 });
process.stdout.write(out);
