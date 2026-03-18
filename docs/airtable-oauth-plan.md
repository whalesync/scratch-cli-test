# Add OAuth Support to AirtableConnector

## Context

The `AirtableOAuthProvider` already exists at `server/src/oauth/providers/airtable-oauth.provider.ts` with `generateAuthUrl`, `exchangeCodeForTokens`, and `refreshTokens` methods. However, it is **not wired up** — it's missing from the OAuth module, service provider map, and the connector instantiation logic. Additionally, Airtable's OAuth2 requires PKCE (S256), which the existing provider doesn't implement. The client-side also doesn't list Airtable as an OAuth-capable service.

This plan wires up the existing provider, adds PKCE support, and gates the feature behind an `ENABLE_AIRTABLE_OAUTH` feature flag.

## Changes

### 1. Add PKCE support to the OAuth infrastructure

**`server/src/oauth/oauth-provider.interface.ts`** — Extend overrides:

- Add `codeChallenge?: string` to `generateAuthUrl` overrides
- Add `codeVerifier?: string` to `exchangeCodeForTokens` overrides

**`server/src/oauth/types.ts`** and **`packages/shared-types/src/dto/oauth/oauth-state-payload.ts`** — Add field:

- Add `codeVerifier?: string` to `OAuthStatePayload` (both copies must stay in sync)

**`server/src/oauth/oauth.service.ts`** — Generate PKCE params for Airtable:

- In `initiateOAuth()`: if service is `AIRTABLE`, generate a `code_verifier` (random 64-byte base64url string) and `code_challenge` (SHA-256 hash, base64url-encoded), include `codeVerifier` in the state payload, and pass `codeChallenge` to `provider.generateAuthUrl()` overrides
- In `handleOAuthCallback()`: extract `codeVerifier` from decoded state payload and pass it to `provider.exchangeCodeForTokens()` overrides

### 2. Fix the Airtable OAuth provider to use PKCE

**`server/src/oauth/providers/airtable-oauth.provider.ts`**:

- In `generateAuthUrl()`: accept `codeChallenge` from overrides, add `code_challenge` and `code_challenge_method=S256` query params to the auth URL
- In `exchangeCodeForTokens()`: accept `codeVerifier` from overrides, include `code_verifier` in the token request body
- Keep existing `AIRTABLE_REDIRECT_URI` env var

### 3. Register the Airtable provider in the OAuth module

**`server/src/oauth/oauth.module.ts`**:

- Import `AirtableOAuthProvider`
- Add to `providers` array

**`server/src/oauth/oauth.service.ts`**:

- Import `AirtableOAuthProvider`
- Inject in constructor
- Register in provider map: `this.providers.set('AIRTABLE', this.airtableProvider)`
- Remove the commented-out placeholder on line 77

### 4. Add OAuth path in connector instantiation

**`server/src/remote-service/connectors/connectors.service.ts`**:

- Modify the `Service.AIRTABLE` case to check `connectorAccount.authType`:
  - If `AuthType.OAUTH`: call `this.oauthService.getValidAccessToken(connectorAccount.id)` and pass the token to `new AirtableConnector(accessToken)` (the Airtable API accepts both PATs and OAuth tokens as Bearer tokens — no constructor change needed)
  - Else: keep existing API key path

### 5. Enable Airtable OAuth in the client (behind feature flag)

**`client/src/hooks/use-connectors.ts`**:

- In `getDefaultAuthMethod()`: add Airtable to OAuth-supported services when `user?.experimentalFlags?.ENABLE_AIRTABLE_OAUTH` is set (same pattern as Webflow/Shopify)
- In `getSupportedAuthMethods()`: same conditional addition
- Add `user?.experimentalFlags?.ENABLE_AIRTABLE_OAUTH` to the `useCallback` dependency arrays

**`client/src/service-naming-conventions.ts`**:

- Add `oauthLabel: 'OAuth'` to the `Service.AIRTABLE` entry

## Files Modified

| File                                                         | Change                                                 |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| `server/src/oauth/oauth-provider.interface.ts`               | Add PKCE fields to overrides                           |
| `server/src/oauth/types.ts`                                  | Add `codeVerifier` to state payload                    |
| `packages/shared-types/src/dto/oauth/oauth-state-payload.ts` | Add `codeVerifier` to state payload                    |
| `server/src/oauth/providers/airtable-oauth.provider.ts`      | Add PKCE params to auth URL and token exchange         |
| `server/src/oauth/oauth.module.ts`                           | Register `AirtableOAuthProvider`                       |
| `server/src/oauth/oauth.service.ts`                          | Inject provider, register in map, generate PKCE params |
| `server/src/remote-service/connectors/connectors.service.ts` | Add OAuth branch for Airtable                          |
| `client/src/hooks/use-connectors.ts`                         | Add Airtable OAuth behind feature flag                 |
| `client/src/service-naming-conventions.ts`                   | Add `oauthLabel` for Airtable                          |

## Verification

1. **Build**: Run `yarn build` from root to confirm no TypeScript errors
2. **Lint**: Run `yarn lint` from root
3. **Server tests**: Run `yarn test` in `server/` to check for regressions
4. **Manual testing** (requires `AIRTABLE_CLIENT_ID`, `AIRTABLE_CLIENT_SECRET`, `AIRTABLE_REDIRECT_URI` env vars and the `ENABLE_AIRTABLE_OAUTH` feature flag enabled for the user):
   - Create a new Airtable connection via OAuth — should redirect to Airtable, authorize, and create a ConnectorAccount with `authType: OAUTH`
   - Verify table listing and record pulling work with the OAuth token
   - Verify token refresh works when the token expires
   - Verify API key connections still work as before
