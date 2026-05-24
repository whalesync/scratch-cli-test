import type { DecryptedCredentials } from '@spinner/shared-types';

/**
 * Response shape for `GET /workbooks/:workbookId/connections/:id/credentials/reveal`.
 *
 * Admin-only "break glass" endpoint that returns the connection's decrypted
 * credentials so an operator can help a customer debug a live connection.
 * Every call is recorded in the audit log.
 */
export interface RevealCredentialsResponse {
  credentials: DecryptedCredentials;
  extras: Record<string, unknown> | null;
}
