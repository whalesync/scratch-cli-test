/**
 * Shared helpers for the QuickBooks Online live-API integration specs.
 *
 * Credentials live in `.env.integration` for a QBO **sandbox** company. Realm id
 * is always required; the access token is supplied one of two ways:
 *   - QUICKBOOKS_ACCESS_TOKEN — a token minted by hand (expires ~1h), or
 *   - QUICKBOOKS_CLIENT_ID + QUICKBOOKS_CLIENT_SECRET + QUICKBOOKS_REFRESH_TOKEN —
 *     the suite mints a fresh access token at startup via the OAuth token endpoint
 *     (refresh tokens roll ~100 days), so runs don't fight the 1h expiry.
 * Optional QUICKBOOKS_SANDBOX=false hits production. These specs self-skip when
 * creds are absent (so CI stays green).
 *
 * NOTE: any spec importing this must also declare the display-names jest.mock
 * (mocks are per-file) to break the connector → display-names circular import.
 */
import axios from 'axios';
import { QuickBooksConnector } from 'src/remote-service/connectors/library/quickbooks/quickbooks-connector';
import { BaseJsonTableSpec, ConnectorFile } from 'src/remote-service/connectors/types';

const ACCESS_TOKEN = process.env.QUICKBOOKS_ACCESS_TOKEN;
export const REALM_ID = process.env.QUICKBOOKS_REALM_ID;
const CLIENT_ID = process.env.QUICKBOOKS_CLIENT_ID;
const CLIENT_SECRET = process.env.QUICKBOOKS_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.QUICKBOOKS_REFRESH_TOKEN;

export const SANDBOX = process.env.QUICKBOOKS_SANDBOX !== 'false'; // sandbox by default for tests
export const QBO_BASE = SANDBOX ? 'https://sandbox-quickbooks.api.intuit.com' : 'https://quickbooks.api.intuit.com';
const OAUTH_TOKEN_ENDPOINT = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const canRefresh = !!CLIENT_ID && !!CLIENT_SECRET && !!REFRESH_TOKEN;

/** True when a realm id plus a usable token source is configured. */
export const hasLiveCreds = !!REALM_ID && (!!ACCESS_TOKEN || canRefresh);

/** Mint a fresh access token from the refresh token via the OAuth token endpoint. */
async function refreshAccessToken(): Promise<string> {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN ?? '' }).toString();
  const response = await axios.post<{ access_token: string }>(OAUTH_TOKEN_ENDPOINT, body, {
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
  });
  return response.data.access_token;
}

/** Resolve an access token once, preferring a refresh (durable) over a pasted token. */
let resolvedAccessToken: string | undefined;
export async function resolveAccessToken(): Promise<string> {
  if (resolvedAccessToken) return resolvedAccessToken;
  resolvedAccessToken = canRefresh ? await refreshAccessToken() : (ACCESS_TOKEN ?? '');
  return resolvedAccessToken;
}

export async function createConnector(): Promise<QuickBooksConnector> {
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return new QuickBooksConnector({ accessToken: await resolveAccessToken(), realmId: REALM_ID! }, { sandbox: SANDBOX });
}

/**
 * The Id of the first record of an entity (optionally filtered by a WHERE clause),
 * to use as a live FK reference. Throws if none exist.
 */
export async function queryFirstId(entityType: string, where?: string): Promise<string> {
  const token = await resolveAccessToken();
  const clause = where ? ` WHERE ${where}` : '';
  const response = await axios.get<{ QueryResponse?: Record<string, { Id: string }[]> }>(
    `${QBO_BASE}/v3/company/${REALM_ID}/query`,
    {
      params: { query: `SELECT * FROM ${entityType}${clause} MAXRESULTS 1` },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    },
  );
  const first = response.data.QueryResponse?.[entityType]?.[0];
  if (!first) throw new Error(`No ${entityType}${clause} in the sandbox to reference`);
  return first.Id;
}

/**
 * Whether a record still exists, via a direct `WHERE Id =` query. Used for delete
 * assertions: a GET on a hard-deleted transaction returns 400 (which the by-id
 * pull path noisily logs), whereas this query cleanly returns an empty result.
 */
export async function recordExistsViaQuery(entityType: string, id: string): Promise<boolean> {
  const token = await resolveAccessToken();
  const response = await axios.get<{ QueryResponse?: Record<string, unknown[]> }>(
    `${QBO_BASE}/v3/company/${REALM_ID}/query`,
    {
      params: { query: `SELECT * FROM ${entityType} WHERE Id = '${id}'` },
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    },
  );
  return (response.data.QueryResponse?.[entityType]?.length ?? 0) > 0;
}

/** Read a single record back by id via the connector's public by-id pull. */
export async function fetchById(
  connector: QuickBooksConnector,
  spec: BaseJsonTableSpec,
  id: string,
): Promise<Record<string, unknown> | null> {
  const got: ConnectorFile[] = [];
  await connector.pullRecordFilesByIds(spec, [id], async ({ files }) => {
    got.push(...files);
    return Promise.resolve();
  });
  return (got[0] as Record<string, unknown> | undefined) ?? null;
}
