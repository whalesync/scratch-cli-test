#!/usr/bin/env node
/**
 * Mint a fresh QuickBooks access token and write it back into a ConnectorAccount's
 * encrypted credentials.
 *
 * WHY THIS EXISTS
 * ---------------
 * The long-running local dev server this audit drives is started from a workspace whose
 * `server/.env` does NOT define `QUICKBOOKS_CLIENT_ID` / `QUICKBOOKS_CLIENT_SECRET`. Without
 * them the server cannot refresh a QuickBooks OAuth token, so every pull started more than an
 * hour after the connection was created fails with:
 *
 *   System OAuth app credentials for QUICKBOOKS v1 are not configured
 *
 * That is a test-environment gap, not a product defect — but it stops the audit dead. Rather
 * than edit another workspace's `.env` and restart a server that may be under a debugger, this
 * refreshes the token out-of-band (using the credentials from THIS worktree's `server/.env`)
 * and stores it with a real future expiry, so the server never needs to refresh mid-run.
 *
 * LOCAL DEV ONLY. Writes to the local Postgres.
 *
 * Usage:
 *   node tools/live-export-audit/seeds/quickbooks/refresh-connection-token.mjs coa_A coa_B …
 */
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const serverEnv = readEnvFile(path.join(REPO_ROOT, 'server/.env'));
const DATABASE_URI = (process.env.DATABASE_URL || serverEnv.DATABASE_URL || '').split('?')[0];
const MASTER_KEY = process.env.ENCRYPTION_MASTER_KEY || serverEnv.ENCRYPTION_MASTER_KEY;
const CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID || serverEnv.QUICKBOOKS_CLIENT_ID;
const CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET || serverEnv.QUICKBOOKS_CLIENT_SECRET;

const connectionIds = process.argv.slice(2).filter((a) => a.startsWith('coa_'));
if (connectionIds.length === 0) {
  console.error('Pass one or more coa_… ids');
  process.exit(1);
}

const psql = (sql) => execFileSync('psql', [DATABASE_URI, '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();

// Mirrors server/src/utils/encryption.ts exactly.
async function decryptBlob(blob) {
  const key = await scryptAsync(MASTER_KEY, Buffer.from(blob.salt, 'hex'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
  decipher.setAAD(Buffer.from('connector-account', 'utf8'));
  decipher.setAuthTag(Buffer.from(blob.encrypted.slice(-32), 'hex'));
  return decipher.update(blob.encrypted.slice(0, -32), 'hex', 'utf8') + decipher.final('utf8');
}

async function encryptBlob(plaintext) {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const key = await scryptAsync(MASTER_KEY, salt, 32);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('connector-account', 'utf8'));
  const encrypted = cipher.update(plaintext, 'utf8', 'hex') + cipher.final('hex');
  return {
    encrypted: encrypted + cipher.getAuthTag().toString('hex'),
    iv: iv.toString('hex'),
    salt: salt.toString('hex'),
  };
}

async function refresh(refreshToken) {
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  if (!res.ok) throw new Error(`refresh failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

for (const connectionId of connectionIds) {
  const rowJson = psql(
    `select row_to_json(t) from (select "encryptedCredentials" from "ConnectorAccount" where id = '${connectionId}') t;`,
  );
  if (!rowJson) {
    console.error(`${connectionId}: not found`);
    continue;
  }
  const credentials = JSON.parse(await decryptBlob(JSON.parse(rowJson).encryptedCredentials));
  const tokens = await refresh(credentials.oauthRefreshToken);

  const updated = {
    ...credentials,
    oauthAccessToken: tokens.access_token,
    oauthRefreshToken: tokens.refresh_token ?? credentials.oauthRefreshToken,
    oauthExpiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
  };
  const blob = await encryptBlob(JSON.stringify(updated));
  const literal = `'${JSON.stringify(blob).replace(/'/g, "''")}'::jsonb`;
  psql(
    `update "ConnectorAccount" set "encryptedCredentials" = ${literal}, "healthStatus" = 'OK',
       "healthStatusMessage" = null, "healthStatusLastCheckedAt" = now(), "updatedAt" = now()
     where id = '${connectionId}';`,
  );
  console.log(`${connectionId}: token refreshed, expires ${updated.oauthExpiresAt}`);
}
