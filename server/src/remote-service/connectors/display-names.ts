import { ConnectorMetadata, ConnectorSettingDefinition, Service } from '@spinner/shared-types';
import { connectorRegistry } from './connector-registry';

/**
 * Maps a Service value to its display name.
 */
export function getServiceDisplayName(service: Service): string {
  const reg = connectorRegistry.get(service);
  if (!reg) {
    return service;
  }
  return reg.metadata.displayName;
}

/**
 * Maps a Service value to its advanced settings definitions.
 */
export function getServiceAdvancedSettings(service: Service): ConnectorSettingDefinition[] {
  return connectorRegistry.get(service)?.advancedSettings ?? [];
}

/**
 * Maps a Service value to its full connector metadata.
 */
export function getServiceMetadata(service: Service): ConnectorMetadata {
  const reg = connectorRegistry.get(service);
  if (!reg) {
    throw new Error(`No connector registered for service: ${service}`);
  }
  return reg.metadata;
}

/**
 * Maps a Service value to its connector's current *code* version, read straight
 * from the registry without instantiating the connector (instantiation needs
 * decrypted credentials we deliberately don't have at account-creation time).
 * Defaults to 1 for connectors that register no version (i.e. every connector
 * today) and for unregistered services. (DEV-10302)
 */
export function getConnectorCurrentVersion(service: string): number {
  return connectorRegistry.get(service)?.version ?? 1;
}

/**
 * Returns connector metadata for all registered services, with supportedAuthMethods from registrations.
 */
export function getAllConnectorMetadata(): Record<string, ConnectorMetadata> {
  const result: Record<string, ConnectorMetadata> = {};
  const entries = [...connectorRegistry.getAll()].sort(([, a], [, b]) =>
    a.metadata.displayName.localeCompare(b.metadata.displayName),
  );
  for (const [service, reg] of entries) {
    const { supportedAuthMethods } = reg;
    const defaultAuthMethod = supportedAuthMethods[0] ?? 'oauth';
    result[service] = { ...reg.metadata, supportedAuthMethods, defaultAuthMethod };
  }
  return result;
}
