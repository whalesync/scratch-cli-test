import { ConnectorSettingDefinition } from './connector-types';

export type AuthMethod = 'oauth' | 'user_provided_params' | 'oauth_custom';

export interface ConnectorMetadata {
  displayName: string;
  table: string;
  tables: string;
  record: string;
  records: string;
  base: string | null;
  bases: string | null;
  logo: string;
  visible: boolean;
  pushOperationName: string;
  pullOperationName: string;
  supportedAuthMethods: AuthMethod[];
  defaultAuthMethod: AuthMethod;
  oauth?: {
    label: string;
    privateLabel?: string;
  };
  credentialFields?: Partial<Record<AuthMethod, ConnectorSettingDefinition[]>>;
  userProvidedParamsLabel?: string;
}

const DEFAULTS: Omit<ConnectorMetadata, 'displayName' | 'logo'> = {
  table: 'table',
  tables: 'tables',
  record: 'record',
  records: 'records',
  base: null,
  bases: null,
  visible: true,
  pushOperationName: 'Publish',
  pullOperationName: 'Download',
  supportedAuthMethods: [],
  defaultAuthMethod: 'oauth',
};

export function connectorMetadata(
  overrides: Pick<ConnectorMetadata, 'displayName' | 'logo'> & Partial<Omit<ConnectorMetadata, 'displayName' | 'logo'>>,
): ConnectorMetadata {
  return { ...DEFAULTS, ...overrides };
}
