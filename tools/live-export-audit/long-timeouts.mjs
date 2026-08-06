/**
 * Preload (node --import) that raises fetch()'s undici header/body timeouts —
 * some spinner endpoints legitimately run past undici's 300s default during
 * audits of slow sources (rate-limited connectors, big schema fetches).
 * Best-effort: the npm undici's global-dispatcher symbol is shared with node's
 * internal fetch when versions are ABI-compatible; if not, this is a no-op.
 */
try {
  const { Agent, setGlobalDispatcher } = await import('undici');
  setGlobalDispatcher(new Agent({ headersTimeout: 1_800_000, bodyTimeout: 1_800_000 }));
} catch {
  // undici not resolvable — keep defaults.
}
