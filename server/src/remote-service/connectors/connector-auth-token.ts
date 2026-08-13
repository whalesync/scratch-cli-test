/**
 * The credential a connector's API client sends on every outbound request.
 *
 * Connectors authenticate with one of two very different kinds of credential:
 *
 *   - a **fixed** secret the user pasted in (API key, personal access token,
 *     private integration token) that never changes for the life of a connection,
 *     and
 *   - a **short-lived OAuth access token** the host mints and re-mints from a
 *     refresh token. Google, HubSpot, and most other providers expire these about
 *     an hour after they are issued.
 *
 * Historically both arrived as a plain `string` that a connector resolved once at
 * instantiation and baked into an `Authorization` header, which meant a job that
 * outlived the access token (a large publish, pull, or sync) 401'd on every call
 * from the expiry moment onward and could never recover (DEV-11270). Modelling the
 * credential as a *provider* instead lets an API client ask for the current token
 * on each request, so the host's refresh is picked up mid-job.
 *
 * Fixed secrets simply become a provider that always returns the same string (see
 * {@link toConnectorAuthTokenProvider}), so the two auth styles stay a single code
 * path inside each connector.
 */
export type ConnectorAuthTokenProvider = () => Promise<string>;

/**
 * What a connector (or its API client) accepts for its credential: either a fixed
 * secret or a {@link ConnectorAuthTokenProvider}. Taking both keeps API-key auth
 * paths — and the many unit tests that construct clients with a literal token —
 * unchanged while OAuth paths pass a live provider.
 */
export type ConnectorAuthTokenOrProvider = string | ConnectorAuthTokenProvider;

/**
 * Normalize a {@link ConnectorAuthTokenOrProvider} to a provider. A fixed secret is
 * wrapped in a provider that resolves to it forever; a provider is returned as-is.
 */
export function toConnectorAuthTokenProvider(
  tokenOrProvider: ConnectorAuthTokenOrProvider,
): ConnectorAuthTokenProvider {
  if (typeof tokenOrProvider === 'string') {
    return () => Promise.resolve(tokenOrProvider);
  }
  return tokenOrProvider;
}
