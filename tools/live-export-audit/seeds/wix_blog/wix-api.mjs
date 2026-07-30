/**
 * Wix Blog direct-API helper for the Live Export audit (source-side seeding + verification).
 *
 * Wix Blog is OAuth-only (client-credentials). This helper mints its own app access token
 * from `client_id` + `client_secret` + `instance_id`, exactly as WixOAuthProvider does, so the
 * audit can seed and read back draft posts through Wix's own API without going through Scratch.
 *
 * Inputs (never committed):
 *   - WIX_CLIENT_ID_V2 / WIX_CLIENT_SECRET_V2 from the local server's .env (oauthAppVersion = 2)
 *   - the instanceId, read from the local ConnectorAccount's decrypted oauthWorkspaceId
 */
import fs from 'node:fs';

export function readEnvFile(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

export async function mintWixAccessToken({ clientId, clientSecret, instanceId }) {
  const res = await fetch('https://www.wixapis.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, instance_id: instanceId }),
  });
  const body = await res.json();
  if (!body.access_token) throw new Error(`Wix token mint failed (${res.status}): ${JSON.stringify(body).slice(0, 400)}`);
  return body.access_token;
}

export function makeWixClient(accessToken) {
  return async function wix(method, path, body) {
    const res = await fetch(`https://www.wixapis.com${path}`, {
      method,
      headers: { Authorization: accessToken, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 1200)}`);
    return json;
  };
}

/** Resolve a ready-to-use Wix API client from the local env + instanceId. */
export async function connectToWix({ envFile, instanceId }) {
  const env = readEnvFile(envFile);
  const accessToken = await mintWixAccessToken({
    clientId: env.WIX_CLIENT_ID_V2,
    clientSecret: env.WIX_CLIENT_SECRET_V2,
    instanceId,
  });
  return makeWixClient(accessToken);
}
