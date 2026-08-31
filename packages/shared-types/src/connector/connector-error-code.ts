/**
 * Stable, connector-agnostic and operation-agnostic codes classifying *what an
 * external service's error meant*, produced by a connector's
 * `extractConnectorErrorDetails` (server/src/remote-service/connectors/) — the
 * one place allowed to sniff the service's own error message/status/code.
 *
 * These values are the cross-repo wire contract between spinner (which
 * produces them), bottlenose, and dusky (which key frontend behavior off
 * them). Consumers must branch ONLY on these codes, never on the
 * human-readable message next to them: the message copy is connector-owned
 * prose and free to change at any time, while these code values must never be
 * renamed or reused.
 *
 * A code states a fact about the failed call, independent of which operation
 * made it. What that fact *means* — and what recovery to offer — attaches at
 * the surface that carries the operation context. Today the only surface that
 * persists a code is the publish runner (`PublishPlanOperation.errorCode` →
 * `PublishFailedOperation.errorCode`), where dusky's Live Export UI turns
 * {@link ConnectorErrorCode.RemoteRecordNotFound} into "run a full sync"
 * recovery copy; pull and HTTP-boundary paths currently discard it.
 */
export const ConnectorErrorCode = {
  /**
   * The remote object this call targeted does not exist (or refuses edits)
   * any more — e.g. it was deleted remotely (a 404 / "not found"), or the
   * service rejects writes because it is archived/trashed (Notion's "Can't
   * edit block that is archived"). Retrying the same call can never succeed.
   * On a publish update this means the destination record is gone and the
   * local mirror is stale; a full sync re-reconciles it against the
   * destination.
   */
  RemoteRecordNotFound: 'remote_record_not_found',
} as const;

export type ConnectorErrorCode = (typeof ConnectorErrorCode)[keyof typeof ConnectorErrorCode];
