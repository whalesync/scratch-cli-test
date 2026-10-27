#!/usr/bin/env node
/**
 * Plant a SALESFORCE OAuth connection in a local workbook without walking the consent screen.
 *
 * WHY THIS EXISTS
 * ---------------
 * Salesforce is OAuth-only, and the browser flow needs the system connected app's secrets in
 * `server/.env` plus a redirect through a deployed Whalesync host. For a local audit that is a lot of
 * ceremony, so this mints an access token for the Salesforce test org with the OAuth password grant
 * and stores it the way `OAuthService.createOAuthAccount` would: `oauthAccessToken`, plus the org's
 * `instance_url` in `oauthWorkspaceId`, which is where the connector sends its API calls.
 *
 * The token has no refresh token and no recorded expiry, so the server never tries to refresh it. It
 * lives as long as the org's session timeout (2 hours by default); re-run with `--refresh` to re-mint
 * it into an existing connection.
 *
 * Credentials: SALESFORCE_TEST_CLIENT_ID / _CLIENT_SECRET / _USERNAME / _PASSWORD (+ optional
 * SALESFORCE_TEST_LOGIN_HOST), read from the environment or `server/.env.integration`. The connected
 * app must allow the username-password flow.
 *
 * LOCAL DEV ONLY. Writes directly to the local Postgres.
 *
 * Usage:
 *   node tools/live-export-audit/seeds/salesforce/create-oauth-connection.mjs --name "QA SALESFORCE -> POSTGRES"
 *   node tools/live-export-audit/seeds/salesforce/create-oauth-connection.mjs --workbook wkb_…
 *   node tools/live-export-audit/seeds/salesforce/create-oauth-connection.mjs --refresh coa_…
 *
 * Prints `{"workbookId":"wkb_…","connectionId":"coa_…", …}` on stdout.
 */
import { execFileSync } from "node:child_process";
import { createCipheriv, randomBytes, scrypt } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else {
      args[key] = next;
      i++;
    }
  }
}

function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

const serverEnv = readEnvFile(path.join(REPO_ROOT, "server/.env"));
const integrationEnv = readEnvFile(
  path.join(REPO_ROOT, "server/.env.integration"),
);
const spinnerEnv = readEnvFile(
  path.join(REPO_ROOT, "local/audit-creds/_spinner.env"),
);
const setting = (name) =>
  process.env[name] ||
  integrationEnv[name] ||
  serverEnv[name] ||
  spinnerEnv[name];

const DATABASE_URI = (setting("DATABASE_URL") || "").split("?")[0];
const MASTER_KEY = setting("ENCRYPTION_MASTER_KEY");
const SPINNER_BASE = setting("SPINNER_API_URL") || "http://localhost:3010";
const SPINNER_TOKEN = setting("SPINNER_API_TOKEN");
const GIT_API_BASE = process.env.SCRATCH_GIT_API_URL || "http://localhost:3100";
const LOGIN_HOST =
  setting("SALESFORCE_TEST_LOGIN_HOST") || "login.salesforce.com";

for (const [name, value] of Object.entries({
  DATABASE_URI,
  MASTER_KEY,
  SPINNER_TOKEN,
})) {
  if (!value) {
    console.error(
      `Missing ${name} (server/.env, local/audit-creds/_spinner.env, or the environment)`,
    );
    process.exit(1);
  }
}

const psql = (sql) =>
  execFileSync("psql", [DATABASE_URI, "-t", "-A", "-c", sql], {
    encoding: "utf8",
  }).trim();

// Mirrors server/src/utils/encryption.ts exactly.
async function encryptBlob(plaintext) {
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const key = await scryptAsync(MASTER_KEY, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("connector-account", "utf8"));
  const encrypted =
    cipher.update(plaintext, "utf8", "hex") + cipher.final("hex");
  return {
    encrypted: encrypted + cipher.getAuthTag().toString("hex"),
    iv: iv.toString("hex"),
    salt: salt.toString("hex"),
  };
}

async function mintPasswordGrantSession() {
  const res = await fetch(`https://${LOGIN_HOST}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: setting("SALESFORCE_TEST_CLIENT_ID") || "",
      client_secret: setting("SALESFORCE_TEST_CLIENT_SECRET") || "",
      username: setting("SALESFORCE_TEST_USERNAME") || "",
      password: setting("SALESFORCE_TEST_PASSWORD") || "",
    }).toString(),
  });
  const body = await res.json();
  if (!res.ok || !body.access_token)
    throw new Error(
      `Salesforce password grant failed: ${JSON.stringify(body)}`,
    );
  return { accessToken: body.access_token, instanceUrl: body.instance_url };
}

async function spinnerApi(method, p, body) {
  const res = await fetch(SPINNER_BASE + p, {
    method,
    headers: {
      Authorization: `API-Token ${SPINNER_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok)
    throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

// nanoid-compatible id: same alphabet and length as packages/shared-types/src/ids.ts
const ID_ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function createId(prefix) {
  const bytes = randomBytes(20);
  let out = "";
  for (let i = 0; out.length < 10; i++)
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return prefix + out;
}

const session = await mintPasswordGrantSession();
const credentialsLiteral = `'${JSON.stringify(
  await encryptBlob(
    JSON.stringify({
      oauthAccessToken: session.accessToken,
      oauthWorkspaceId: session.instanceUrl,
    }),
  ),
).replace(/'/g, "''")}'::jsonb`;

if (args.refresh) {
  const connectionId = args.refresh;
  const workbookId = psql(
    `select "workbookId" from "ConnectorAccount" where id = '${connectionId}' and service = 'SALESFORCE';`,
  );
  if (!workbookId) throw new Error(`No SALESFORCE connection ${connectionId}`);
  psql(
    `update "ConnectorAccount" set "encryptedCredentials" = ${credentialsLiteral}, "healthStatus" = 'OK',
       "healthStatusMessage" = null, "healthStatusLastCheckedAt" = now(), "updatedAt" = now()
     where id = '${connectionId}';`,
  );
  console.log(
    JSON.stringify({
      workbookId,
      connectionId,
      refreshed: true,
      instanceUrl: session.instanceUrl,
    }),
  );
  process.exit(0);
}

const workbookId =
  args.workbook ||
  (
    await spinnerApi("POST", "/workbook", {
      name: args.name || "QA SALESFORCE",
    })
  ).id;
const workbook = JSON.parse(
  psql(
    `select row_to_json(t) from (select "organizationId", "userId" from "Workbook" where id = '${workbookId}') t;`,
  ),
);
const connectionId = createId("coa_");
const repoPath = [workbook.organizationId, workbookId, connectionId].join("/");

psql(
  `insert into "ConnectorAccount"
     (id, "userId", "workbookId", service, "displayName", "authType", "oauthAppVersion",
      "repoPath", "encryptedCredentials", "healthStatus", "healthStatusLastCheckedAt", "createdAt", "updatedAt")
   values
     ('${connectionId}', '${workbook.userId}', '${workbookId}', 'SALESFORCE', 'qa-source-SALESFORCE (password grant)',
      'OAUTH', 1, '${repoPath}', ${credentialsLiteral}, 'OK', now(), now(), now());`,
);

const encodedRepoId = repoPath.split("/").map(encodeURIComponent).join("%2F");
const initRes = await fetch(
  `${GIT_API_BASE}/api/repo/manage/${encodedRepoId}/init`,
  { method: "POST" },
);
if (!initRes.ok) {
  console.error(
    `WARN: initRepo ${repoPath} -> ${initRes.status} ${(await initRes.text()).slice(0, 300)}`,
  );
}

const test = await spinnerApi(
  "POST",
  `/workbooks/${workbookId}/connections/${connectionId}/test`,
  {},
);
console.log(
  JSON.stringify({
    workbookId,
    connectionId,
    repoPath,
    instanceUrl: session.instanceUrl,
    test,
  }),
);
