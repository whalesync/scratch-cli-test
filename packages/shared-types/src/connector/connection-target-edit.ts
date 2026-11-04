import { ConnectorSettingDefinition } from './dtos';

/**
 * Editing where a connection sends its credentials (DEV-12723): an edit that changes a `connectionTarget` field must
 * send the connection's secret fields again, so a saved secret is only ever sent to the address it was entered for.
 * The server enforces the rule; these helpers let the web and desktop edit forms ask for the secrets up front, with the
 * server's own wording.
 */

/** What an edit form must ask for while the user is changing where a connection points. */
export interface SecretFieldsToReenterForConnectionTargetEdit {
  /** The `connectionTarget` fields the user has typed a value into. */
  connectionTargetFieldsBeingEdited: ConnectorSettingDefinition[];
  /**
   * The required `password` fields the edit must send again. Empty while no target field has a value. The server also
   * requires an optional secret that is currently stored, which a form can't see, so its 400 message covers that case.
   */
  secretFieldsToReenter: ConnectorSettingDefinition[];
}

/** Whether a credential value counts as sent: text with something other than whitespace in it. */
export function isNonBlankCredentialValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * The secret fields an edit form must require, given the values the user has typed so far. A form can't see the stored
 * values (credentials never leave the server), so any text in a `connectionTarget` field counts as a change.
 */
export function resolveSecretFieldsToReenterForConnectionTargetEdit(
  credentialFields: readonly ConnectorSettingDefinition[],
  typedValueByFieldKey: Readonly<Record<string, unknown>>,
): SecretFieldsToReenterForConnectionTargetEdit {
  const connectionTargetFieldsBeingEdited = credentialFields.filter(
    (field) => field.connectionTarget === true && isNonBlankCredentialValue(typedValueByFieldKey[field.key]),
  );
  const secretFieldsToReenter =
    connectionTargetFieldsBeingEdited.length === 0
      ? []
      : credentialFields.filter((field) => field.type === 'password' && field.required === true);
  return { connectionTargetFieldsBeingEdited, secretFieldsToReenter };
}

/**
 * The message for an edit that changes where a connection sends its credentials without sending its secrets again.
 * The server's 400 and both edit forms use it, so the wording is the same everywhere.
 */
export function describeSecretsToReenterForConnectionTargetChange(
  secretFieldLabels: readonly string[],
  connectionTargetLabels: readonly string[],
): string {
  return (
    `Enter the ${joinLabelsWithOxfordComma(secretFieldLabels)} again when you change the ` +
    `${joinLabelsWithOxfordComma(connectionTargetLabels)}. ` +
    'Scratch only sends a saved secret to the address it was entered for.'
  );
}

/** `A`, `A and B`, `A, B, and C`. */
export function joinLabelsWithOxfordComma(labels: readonly string[]): string {
  if (labels.length <= 2) {
    return labels.join(' and ');
  }
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`;
}
