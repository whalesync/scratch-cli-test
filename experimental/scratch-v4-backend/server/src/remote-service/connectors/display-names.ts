import { ConnectorSettingDefinition, Service } from 'src/types/shared-types';
import { AirtableConnector } from './library/airtable/airtable-connector';
import { WebflowConnector } from './library/webflow/webflow-connector';

interface ConnectorStaticMetadata {
  readonly displayName: string;
  readonly advancedSettings: ConnectorSettingDefinition[];
}

const CONNECTOR_MAP: Partial<Record<Service, ConnectorStaticMetadata>> = {
  [Service.AIRTABLE]: AirtableConnector,
  [Service.WEBFLOW]: WebflowConnector,
};

export function getServiceDisplayName(service: Service): string {
  return CONNECTOR_MAP[service]?.displayName ?? service;
}

export function getServiceAdvancedSettings(service: Service): ConnectorSettingDefinition[] {
  return CONNECTOR_MAP[service]?.advancedSettings ?? [];
}
