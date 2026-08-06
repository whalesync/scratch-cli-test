/**
 * Scheme validation for every URL the renderer asks the main process to hand to the operating
 * system via `shell.openExternal` (DEV-10998 / Oneleet finding SCR-003).
 *
 * `shell.openExternal` does not just open web pages — it dispatches to whichever application
 * has registered the URL's scheme. Without a check, a renderer-controlled string reaches
 * `file://` (open local files/folders), `smb://` (NTLM relay, credential leak on Windows), and
 * every custom protocol handler installed on the machine. Oneleet confirmed this by opening
 * `file:///C:/Windows/System32/` from the renderer.
 *
 * This module lives apart from `index.ts` deliberately: `index.ts` runs Electron app lifecycle
 * side effects at import time, so it cannot be imported from a unit test.
 */

/**
 * Hostnames that resolve to this machine. Matching is exact, never by suffix —
 * `localhost.evil.com` and `127.0.0.1.evil.com` are ordinary remote hosts.
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export interface ExternalUrlPolicy {
  /**
   * Whether plain `http:` on a loopback host is acceptable. True only in development, where
   * `VITE_SCRATCH_WEB_URL` defaults to `http://localhost:3000` and the billing/review links are
   * built from it.
   *
   * Packaged builds always point at an https origin, so they set this false. That matters: on a
   * developer's machine loopback covers every local service on every port, so allowing it in a
   * shipped build would hand a compromised renderer a top-level GET against whatever the user
   * happens to be running locally.
   */
  allowLoopbackHttp: boolean;
}

/**
 * True when `rawUrl` is safe to hand to `shell.openExternal`.
 *
 * Allowlist, not a denylist: `https:` anywhere, `http:` on loopback only when the policy permits
 * it. Every other scheme — including ones we have not thought of and ones installed by other
 * software on the user's machine — is rejected. Malformed input is rejected rather than throwing,
 * so callers do not need their own try/catch.
 *
 * Custom application schemes are deliberately NOT allowlisted. The app's `claude://` and
 * `codex://` deep links go through `buildAgentDeepLinkUrl` in `agent-deep-link.ts` instead, so
 * the renderer supplies parameters rather than choosing a scheme.
 */
export function isSafeExternalUrl(rawUrl: string, policy: ExternalUrlPolicy): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsedUrl.protocol === 'https:') {
    return true;
  }

  if (parsedUrl.protocol === 'http:') {
    return policy.allowLoopbackHttp && LOOPBACK_HOSTNAMES.has(parsedUrl.hostname);
  }

  return false;
}
