/**
 * Minimal QuickBooks Online API client for the Live Export audit seeds.
 *
 * Auth: reads the OAuth tokens straight out of the local `ConnectorAccount` row (the
 * connection a human established through the UI), decrypting the same AES-256-GCM blob
 * the server uses. Tokens are then cached in `local/audit-creds/.qbo-token.json` so
 * repeated script runs don't hammer Intuit's token endpoint.
 *
 * Why cache: QBO access tokens live ~1h and Intuit ROTATES the refresh token roughly
 * daily (the previous one stays valid ~24h). Every unnecessary refresh is a chance to
 * desync the app's stored copy, so we refresh only when the cached access token is
 * actually near expiry, and we surface a loud warning if the refresh token rotates.
 *
 * READ-ONLY with respect to the database — this never writes tokens back.
 */
import { execFileSync } from 'node:child_process';
import { createDecipheriv, scrypt } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const TOKEN_CACHE_PATH = path.join(REPO_ROOT, 'local/audit-creds/.qbo-token.json');

export function readEnvFile(file) {
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
const ENCRYPTION_MASTER_KEY = process.env.ENCRYPTION_MASTER_KEY || serverEnv.ENCRYPTION_MASTER_KEY;
const CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID || serverEnv.QUICKBOOKS_CLIENT_ID;
const CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET || serverEnv.QUICKBOOKS_CLIENT_SECRET;
const OAUTH_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

function psql(sql) {
  return execFileSync('psql', [DATABASE_URI, '-t', '-A', '-c', sql], { encoding: 'utf8' }).trim();
}

async function decryptBlob(blob) {
  const key = await scryptAsync(ENCRYPTION_MASTER_KEY, Buffer.from(blob.salt, 'hex'), 32);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
  decipher.setAAD(Buffer.from('connector-account', 'utf8'));
  decipher.setAuthTag(Buffer.from(blob.encrypted.slice(-32), 'hex'));
  return decipher.update(blob.encrypted.slice(0, -32), 'hex', 'utf8') + decipher.final('utf8');
}

/** Pull realmId + sandbox flag + OAuth tokens out of a ConnectorAccount row. */
async function readConnectionFromDb(connectorAccountId) {
  const rowJson = psql(
    `select row_to_json(t) from (select "encryptedCredentials", extras from "ConnectorAccount" where id = '${connectorAccountId}') t;`,
  );
  if (!rowJson) throw new Error(`No ConnectorAccount ${connectorAccountId}`);
  const row = JSON.parse(rowJson);
  const credentials = JSON.parse(await decryptBlob(row.encryptedCredentials));
  return {
    realmId: row.extras.realmId,
    sandbox: row.extras.sandbox ?? false,
    accessToken: credentials.oauthAccessToken,
    refreshToken: credentials.oauthRefreshToken,
    expiresAt: credentials.oauthExpiresAt,
  };
}

async function refreshAccessToken(refreshToken) {
  const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(OAUTH_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }).toString(),
  });
  if (!res.ok) throw new Error(`QBO token refresh failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const tokens = await res.json();
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    console.error(
      'WARNING: Intuit rotated the refresh token. The ConnectorAccount rows still hold the previous ' +
        'one (valid ~24h). Re-authenticate the connection in the UI before that lapses.',
    );
  }
  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token ?? refreshToken,
    expiresAtMs: Date.now() + tokens.expires_in * 1000,
  };
}

/**
 * Build an authenticated QBO client for the company behind `connectorAccountId`.
 * Reuses a cached access token while it has >5min of life left.
 */
export async function createQboClient(connectorAccountId) {
  const connection = await readConnectionFromDb(connectorAccountId);

  let cached = null;
  if (fs.existsSync(TOKEN_CACHE_PATH)) {
    try {
      cached = JSON.parse(fs.readFileSync(TOKEN_CACHE_PATH, 'utf8'));
    } catch {
      cached = null;
    }
  }

  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  let accessToken;
  if (cached?.realmId === connection.realmId && cached.expiresAtMs - Date.now() > FIVE_MINUTES_MS) {
    accessToken = cached.accessToken;
  } else {
    const refreshed = await refreshAccessToken(cached?.refreshToken ?? connection.refreshToken);
    accessToken = refreshed.accessToken;
    fs.writeFileSync(TOKEN_CACHE_PATH, JSON.stringify({ realmId: connection.realmId, ...refreshed }, null, 1));
  }

  const host = connection.sandbox
    ? 'https://sandbox-quickbooks.api.intuit.com'
    : 'https://quickbooks.api.intuit.com';
  const baseUrl = `${host}/v3/company/${connection.realmId}`;

  async function request(method, endpoint, body) {
    const url = `${baseUrl}${endpoint}${endpoint.includes('?') ? '&' : '?'}minorversion=70`;
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (!res.ok) {
      const fault = json?.fault ?? json?.Fault;
      const detail = fault?.error?.[0] ?? fault?.Error?.[0];
      const message = detail ? `${detail.Message ?? detail.message}: ${detail.Detail ?? detail.detail}` : text.slice(0, 400);
      const error = new Error(`QBO ${method} ${endpoint} -> ${res.status}: ${message}`);
      error.status = res.status;
      error.responseBody = json;
      throw error;
    }
    return json;
  }

  return {
    realmId: connection.realmId,
    sandbox: connection.sandbox,
    baseUrl,

    /** Run a QBO SQL-ish query and return the entity array (empty when none matched). */
    async query(statement) {
      const result = await request('GET', `/query?query=${encodeURIComponent(statement)}`);
      const queryResponse = result.QueryResponse ?? {};
      const entityKey = Object.keys(queryResponse).find((k) => Array.isArray(queryResponse[k]));
      return entityKey ? queryResponse[entityKey] : [];
    },

    /** Count via QBO's COUNT(*) projection. NOTE: returns 0 for the CompanyInfo singleton. */
    async count(entityType) {
      const result = await request('GET', `/query?query=${encodeURIComponent(`SELECT COUNT(*) FROM ${entityType}`)}`);
      return result.QueryResponse?.totalCount ?? 0;
    },

    /** Create or sparse-update an entity. QBO uses one POST endpoint for both. */
    async write(entityType, payload) {
      const result = await request('POST', `/${entityType.toLowerCase()}`, payload);
      return result[entityType] ?? result;
    },

    async read(entityType, id) {
      const result = await request('GET', `/${entityType.toLowerCase()}/${id}`);
      return result[entityType] ?? result;
    },

    /** Hard-delete a transaction entity (name-list entities must be deactivated instead). */
    async deleteTransaction(entityType, id, syncToken) {
      const result = await request('POST', `/${entityType.toLowerCase()}?operation=delete`, { Id: id, SyncToken: syncToken });
      return result[entityType] ?? result;
    },

    /** Batch endpoint — max 30 operations per request. */
    async batch(batchItemRequest) {
      const result = await request('POST', '/batch', { BatchItemRequest: batchItemRequest });
      return result.BatchItemResponse ?? [];
    },

    request,
  };
}
