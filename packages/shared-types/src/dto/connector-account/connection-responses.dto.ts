/** Response for `POST .../connections/:id/test`. */
export type TestConnectionResponse = { health: 'ok' } | { health: 'error'; error: string };

/**
 * Response for `GET .../connections/:id/quota`.
 *   - `{ supported: true; quota }` — raw API quota data, rendered as JSON.
 *   - `{ supported: false; dashboardUrl }` — link to the service's usage dashboard.
 *   - `{ supported: false }` — no quota concept at all.
 */
export type ApiQuotaResponse =
  | { supported: true; quota: Record<string, unknown> }
  | { supported: false; dashboardUrl?: string };

/**
 * Response for `GET .../connections/:id/credentials/reveal`. Admin-only "break
 * glass" reveal of a connection's decrypted credentials; every call is audited.
 */
export interface RevealCredentialsResponse {
  credentials: Record<string, unknown>;
  extras: Record<string, unknown> | null;
}

/**
 * Body shape of the HTTP 409 returned when a live edit or a new job enqueue is
 * refused because the connection is being migrated (DEV-9698 T4 — its
 * `ConnectorAccount.migrationLockedAt` is set while a code-migration quiesces it).
 * The window is short and admin-coordinated; the client should surface the
 * message and let the user retry once the migration finishes. Returned via a
 * NestJS `ConflictException` whose body serializes as `{ statusCode: 409, ...this }`
 * — mirrors the `blocked_dirty` gate shape.
 */
export interface ConnectionMigratingBlockedResponseDto {
  status: 'blocked_migrating';
  /** The connection currently being migrated. */
  connectorAccountId: string;
  /** Human-readable message; NestJS sets this automatically from ConflictException. */
  message?: string;
}
