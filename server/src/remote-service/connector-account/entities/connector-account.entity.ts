import { Prisma, ConnectorAccount as PrismaConnectorAccount } from '@prisma/client';
import { AuthType, ConnectorAccount as ConnectorAccountWire, ConnectorHealthStatus } from '@spinner/shared-types';
import { DecryptedCredentials } from '../types/encrypted-credentials.interface';

export type ConnectorAccount = Pick<
  PrismaConnectorAccount,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'userId'
  | 'workbookId'
  | 'service'
  | 'displayName'
  | 'authType'
  | 'encryptedCredentials'
  | 'healthStatus'
  | 'healthStatusLastCheckedAt'
  | 'healthStatusMessage'
  | 'modifier'
  | 'extras'
  | 'version'
  | 'repoPath'
>;

export type ConnectorAccountWithCredentials = ConnectorAccount & DecryptedCredentials;

function normalizeExtras(value: Prisma.JsonValue | null | undefined): Record<string, unknown> | null {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

/**
 * Projects an internal connector-account row to the client-facing wire {@link ConnectorAccountWire}
 * object via an explicit ALLOWLIST.
 *
 * Security-critical (DEV-11011 / SCR-016): this deliberately (a) DROPS the `encryptedCredentials`
 * envelope and (b) NEVER copies any decrypted `DecryptedCredentials` field that may be spread onto
 * the input object — e.g. by `ConnectorAccountService.getDecryptedAccount`, which returns
 * `{ ...account, ...decryptedCredentials }`. Credentials — encrypted OR plaintext — must never
 * cross the HTTP boundary through the connections API. The only sanctioned outbound path for
 * decrypted credentials is the admin-gated, audited `…/credentials/reveal` endpoint.
 *
 * Because this builds an explicit object literal typed as `ConnectorAccountWire`, adding a secret
 * field here fails type-checking — the allowlist can only ever be widened deliberately.
 */
export const ConnectorAccountEntity = {
  from(account: ConnectorAccount): ConnectorAccountWire {
    return {
      id: account.id,
      createdAt: account.createdAt.toISOString(),
      updatedAt: account.updatedAt.toISOString(),
      // `userId` is nullable in the DB (User is `onDelete: SetNull`) but the wire contract has long
      // declared it non-null; preserve that contract rather than widen it in a security patch.
      userId: account.userId as string,
      workbookId: account.workbookId,
      service: account.service,
      displayName: account.displayName,
      // Prisma enums and the shared enums carry identical string values but are nominally distinct
      // types; the values are guaranteed equal, so a direct cast is safe (cf. job.entity.ts).
      authType: account.authType as AuthType,
      healthStatus: account.healthStatus as ConnectorHealthStatus | null,
      healthStatusLastCheckedAt: account.healthStatusLastCheckedAt
        ? account.healthStatusLastCheckedAt.toISOString()
        : null,
      healthStatusMessage: account.healthStatusMessage,
      modifier: account.modifier,
      extras: normalizeExtras(account.extras),
      version: account.version,
      repoPath: account.repoPath,
    };
  },
};
