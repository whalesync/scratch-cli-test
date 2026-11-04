import { BadRequestException } from '@nestjs/common';
import { AuthType } from '@prisma/client';
import {
  AuthMethod,
  ConnectorSettingDefinition,
  describeSecretsToReenterForConnectionTargetChange,
  isNonBlankCredentialValue,
  joinLabelsWithOxfordComma,
} from '@spinner/shared-types';
import _ from 'lodash';

/**
 * A connection's stored credentials can't be moved somewhere new by an edit (DEV-12723).
 *
 * Any workbook editor can edit a connection, but only admins can reveal its credentials. A connector builds its request
 * target from fields its metadata marks `connectionTarget` (a site URL, a shop domain, a project id that becomes part
 * of the host). If an edit could change one of those while the stored secret stayed, the connector would send that
 * secret to the new target on its next call. So an edit that points the connection at a target it hasn't used before
 * must send the connection's secrets again, in the same request; MySQL's parser applies the same rule to its host,
 * port, and username (DEV-12579).
 */

/** A connection's credentials and extras: as stored, or exactly as an edit would store them. */
export interface ConnectionCredentialsAndExtras {
  credentials: object;
  /** `ConnectorAccount.extras`: any JSON. Only a plain object holds values the check reads. */
  extras: unknown;
}

/**
 * The value a target is compared by. A URL is compared by its scheme and host (port included), since that's where a
 * request goes: a path change on the same host isn't a new target, while a new host, a new port, or `https` → `http` is.
 * The same WHATWG parser the connectors' HTTP clients use reads it, so userinfo, backslashes, and percent-encoding
 * resolve to the same host here as at the request. Anything else (a subdomain, a project id, a bare shop domain) is
 * compared as trimmed, lowercased text.
 */
export function connectionTargetIdentity(connectionTargetValue: string): string {
  const trimmedConnectionTargetValue = connectionTargetValue.trim();
  try {
    const parsedConnectionTargetUrl = new URL(trimmedConnectionTargetValue);
    if (parsedConnectionTargetUrl.host !== '') {
      return `${parsedConnectionTargetUrl.protocol}//${parsedConnectionTargetUrl.host}`.toLowerCase();
    }
  } catch {
    // Not an absolute URL: compared as text below.
  }
  return trimmedConnectionTargetValue.toLowerCase();
}

/**
 * The identity of a target value that isn't text. Where it points can't be read, so it never matches a target read
 * from text: replacing it with a real address counts as a new target (fail closed, as MySQL treats an unreadable
 * stored target), while leaving it as it is doesn't.
 */
function unreadableConnectionTargetIdentity(connectionTargetFieldKey: string): string {
  return `unreadable value in ${connectionTargetFieldKey}`;
}

/**
 * Every target a connection's state points at, with the field each came from. A field's value is read from the
 * credentials and from `extras` under the same key, because Shopify keeps its shop domain in extras. Blank values point
 * nowhere and are skipped.
 */
function collectConnectionTargetIdentities(
  connectionTargetFields: readonly ConnectorSettingDefinition[],
  connectionCredentialsAndExtras: ConnectionCredentialsAndExtras,
): Map<string, ConnectorSettingDefinition> {
  const credentialValueByKey = connectionCredentialsAndExtras.credentials as Record<string, unknown>;
  const extrasValueByKey: Record<string, unknown> = _.isPlainObject(connectionCredentialsAndExtras.extras)
    ? (connectionCredentialsAndExtras.extras as Record<string, unknown>)
    : {};
  const connectionTargetFieldByIdentity = new Map<string, ConnectorSettingDefinition>();
  for (const connectionTargetField of connectionTargetFields) {
    const connectionTargetValues = [
      credentialValueByKey[connectionTargetField.key],
      extrasValueByKey[connectionTargetField.key],
    ];
    for (const connectionTargetValue of connectionTargetValues) {
      if (connectionTargetValue === undefined || connectionTargetValue === null) continue;
      if (typeof connectionTargetValue !== 'string') {
        connectionTargetFieldByIdentity.set(
          unreadableConnectionTargetIdentity(connectionTargetField.key),
          connectionTargetField,
        );
        continue;
      }
      if (connectionTargetValue.trim() === '') continue;
      connectionTargetFieldByIdentity.set(connectionTargetIdentity(connectionTargetValue), connectionTargetField);
    }
  }
  return connectionTargetFieldByIdentity;
}

/**
 * Refuse an edit that points a connection at a target it hasn't used before unless it sends the connection's secrets
 * again, before anything is stored. Returns the targets the edit adds (identities, never secrets) so the caller can
 * record them in the audit log; empty when the edit adds none.
 *
 * - **Targets** come from the `connectionTarget` credential fields of every auth method. Clearing one, re-sending the
 *   value already stored, or changing only a URL's path adds nothing.
 * - **Secrets** are the `user_provided_params` fields of type `password` that are required or currently stored. Each
 *   must be sent as non-blank text, so a field typed and then cleared (`''`) doesn't count. Identifiers sent alongside
 *   them (a username, an access key id) aren't secrets, as in MySQL's rule.
 * - **OAuth connections** authenticate with server-written tokens no edit can send, so a target change is refused
 *   outright: reconnecting is the way to point them somewhere else. Every other connection, including the deprecated
 *   `API_KEY` type, holds the credentials its user entered and is treated as `USER_PROVIDED_PARAMS`.
 *
 * `connectionStateAfterEdit` must be exactly what would be written (after Shopify's shop domain moves into extras), so
 * no rearrangement on the way to storage can hide a changed target.
 */
export function assertEditResendsSecretsWhenItAddsAConnectionTarget(params: {
  credentialFieldsByAuthMethod: Partial<Record<AuthMethod, ConnectorSettingDefinition[]>>;
  authType: AuthType;
  connectionStateBeforeEdit: ConnectionCredentialsAndExtras;
  connectionStateAfterEdit: ConnectionCredentialsAndExtras;
  userProvidedParamsFromEdit: object | undefined;
}): string[] {
  const connectionTargetFields = _.uniqBy(
    Object.values(params.credentialFieldsByAuthMethod)
      .flatMap((credentialFields) => credentialFields ?? [])
      .filter((credentialField) => credentialField.connectionTarget === true),
    (connectionTargetField) => connectionTargetField.key,
  );
  if (connectionTargetFields.length === 0) {
    return [];
  }

  const connectionTargetFieldByIdentityBeforeEdit = collectConnectionTargetIdentities(
    connectionTargetFields,
    params.connectionStateBeforeEdit,
  );
  const connectionTargetsAddedByEdit = [
    ...collectConnectionTargetIdentities(connectionTargetFields, params.connectionStateAfterEdit).entries(),
  ].filter(
    ([connectionTargetIdentityAfterEdit]) =>
      !connectionTargetFieldByIdentityBeforeEdit.has(connectionTargetIdentityAfterEdit),
  );
  if (connectionTargetsAddedByEdit.length === 0) {
    return [];
  }
  const changedConnectionTargetLabels = _.uniq(
    connectionTargetsAddedByEdit.map(([, connectionTargetField]) => connectionTargetField.label),
  );

  if (params.authType === AuthType.OAUTH) {
    throw new BadRequestException(
      `This connection's ${joinLabelsWithOxfordComma(changedConnectionTargetLabels)} can't be changed here. ` +
        'Reconnect it instead.',
    );
  }

  const storedCredentialValueByKey = params.connectionStateBeforeEdit.credentials as Record<string, unknown>;
  const secretFieldsToSendAgain = (params.credentialFieldsByAuthMethod.user_provided_params ?? []).filter(
    (credentialField) =>
      credentialField.type === 'password' &&
      (credentialField.required === true || isNonBlankCredentialValue(storedCredentialValueByKey[credentialField.key])),
  );
  const userProvidedParamValueByKey = (params.userProvidedParamsFromEdit ?? {}) as Record<string, unknown>;
  const secretFieldsNotSentAgain = secretFieldsToSendAgain.filter(
    (secretField) => !isNonBlankCredentialValue(userProvidedParamValueByKey[secretField.key]),
  );
  if (secretFieldsNotSentAgain.length > 0) {
    throw new BadRequestException(
      describeSecretsToReenterForConnectionTargetChange(
        secretFieldsNotSentAgain.map((secretField) => secretField.label),
        changedConnectionTargetLabels,
      ),
    );
  }

  return connectionTargetsAddedByEdit.map(([connectionTargetIdentityAfterEdit]) => connectionTargetIdentityAfterEdit);
}
