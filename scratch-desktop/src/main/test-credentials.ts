import { app } from 'electron';
import { saveCredentials } from './auth-store';

/**
 * Environment variable consumed by automated end-to-end tests (Playwright `_electron`) to
 * seed an already-logged-in session, bypassing the interactive device-code OAuth flow that
 * a headless test cannot drive (the login happens in the system browser via Clerk).
 *
 * The value is the JSON form of the credentials the desktop normally persists after a
 * successful login:
 *
 *   {
 *     "apiToken": "<API-Token for a dedicated test account>",
 *     "email": "e2e@whalesync.com",
 *     "tokenExpiresAt": "2099-01-01T00:00:00Z",   // ISO-8601, must be in the future
 *     "serverUrl": "https://test-api.scratch.md"
 *   }
 *
 * Honored ONLY in unpackaged (dev) builds, so a shipped app can never be coerced into
 * trusting an externally-supplied token through this seam.
 */
export const TEST_CREDENTIALS_ENV_VAR = 'SCRATCH_DESKTOP_TEST_CREDENTIALS_JSON';

export interface SeededTestCredentials {
  apiToken: string;
  email: string;
  tokenExpiresAt: string;
  serverUrl: string;
}

/**
 * If {@link TEST_CREDENTIALS_ENV_VAR} is set in a dev build, parse it, persist it to the auth
 * store (so the renderer's AuthProvider finds a valid token and skips LoginPage), and point
 * the scratchmd CLI + in-process napi at the same server via `SCRATCH_URL`.
 *
 * Returns the parsed credentials so the caller can additionally sync them to the scratchmd CLI
 * (`scratchmd auth set-credentials`); returns `null` when there is nothing to seed.
 *
 * Throws if the env var is present but malformed — a misconfigured test should fail loudly,
 * not silently fall back to the login screen.
 */
export function seedTestCredentialsFromEnvIfPresent(): SeededTestCredentials | null {
  const rawTestCredentialsJson = process.env[TEST_CREDENTIALS_ENV_VAR];
  if (!rawTestCredentialsJson) {
    return null;
  }

  if (app.isPackaged) {
    console.warn(`[test-credentials] ${TEST_CREDENTIALS_ENV_VAR} is ignored in packaged builds.`);
    return null;
  }

  let parsedTestCredentials: Partial<SeededTestCredentials>;
  try {
    parsedTestCredentials = JSON.parse(rawTestCredentialsJson) as Partial<SeededTestCredentials>;
  } catch (parseError) {
    throw new Error(`[test-credentials] ${TEST_CREDENTIALS_ENV_VAR} is not valid JSON: ${String(parseError)}`);
  }

  const { apiToken, email, tokenExpiresAt, serverUrl } = parsedTestCredentials;
  if (!apiToken || !email || !tokenExpiresAt || !serverUrl) {
    throw new Error(
      `[test-credentials] ${TEST_CREDENTIALS_ENV_VAR} must include apiToken, email, tokenExpiresAt, and serverUrl.`,
    );
  }

  const seededTestCredentials: SeededTestCredentials = { apiToken, email, tokenExpiresAt, serverUrl };
  saveCredentials(seededTestCredentials);
  // Keep the scratchmd CLI (spawned children) and the in-process napi pointed at the same
  // server the desktop is now authenticated against — credentials are keyed by hostname.
  process.env.SCRATCH_URL = serverUrl;
  console.warn(
    `[test-credentials] Seeded a test session for ${email} against ${serverUrl} (dev build only — never in production).`,
  );
  return seededTestCredentials;
}
