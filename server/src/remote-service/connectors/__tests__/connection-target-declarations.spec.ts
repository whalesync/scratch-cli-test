// Registers every connector, as the server does at startup.
import { ConnectorSettingDefinition } from '@spinner/shared-types';
import { connectorRegistry } from '../connector-registry';
import '../library';

/**
 * Words that suggest a credential field decides where the connector sends its credentials. A text field matching one
 * must say whether it's a connection target, so a new connector can't silently reopen DEV-12723: an edit that changes
 * an undeclared target would keep the stored secret and send it to the new address.
 */
const LOOKS_LIKE_A_CONNECTION_TARGET_PATTERN = /url|domain|host|endpoint|subdomain|instance|project|site/i;

const registeredConnectors = [...connectorRegistry.getAll()].map(([service, registration]) => ({
  service,
  credentialFields: Object.values(registration.metadata.credentialFields ?? {}).flatMap(
    (credentialFieldsForAuthMethod: ConnectorSettingDefinition[] | undefined) => credentialFieldsForAuthMethod ?? [],
  ),
  userProvidedParamsFields: registration.metadata.credentialFields?.user_provided_params ?? [],
}));

describe('connection target declarations (DEV-12723)', () => {
  it('sees the registered connectors', () => {
    expect(registeredConnectors.length).toBeGreaterThan(20);
  });

  it.each(registeredConnectors.map((connector) => [connector.service, connector] as const))(
    '%s: every URL-, domain-, or host-like text credential field says whether it is a connection target',
    (_service, connector) => {
      const undeclaredFieldKeys = connector.credentialFields
        .filter(
          (credentialField) =>
            credentialField.type === 'string' &&
            (LOOKS_LIKE_A_CONNECTION_TARGET_PATTERN.test(credentialField.key) ||
              LOOKS_LIKE_A_CONNECTION_TARGET_PATTERN.test(credentialField.label)) &&
            credentialField.connectionTarget === undefined,
        )
        .map((credentialField) => credentialField.key);
      expect(undeclaredFieldKeys).toEqual([]);
    },
  );

  it.each(registeredConnectors.map((connector) => [connector.service, connector] as const))(
    '%s: a connector with a connection target has a required secret for edits to ask for',
    (_service, connector) => {
      const hasConnectionTarget = connector.credentialFields.some(
        (credentialField) => credentialField.connectionTarget === true,
      );
      const hasRequiredSecret = connector.userProvidedParamsFields.some(
        (credentialField) => credentialField.type === 'password' && credentialField.required === true,
      );
      expect(!hasConnectionTarget || hasRequiredSecret).toBe(true);
    },
  );
});
