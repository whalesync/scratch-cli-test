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
  oauth?: {
    label: string;
    privateLabel?: string;
  };
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
};

export function connectorMetadata(
  overrides: Pick<ConnectorMetadata, 'displayName' | 'logo'> & Partial<Omit<ConnectorMetadata, 'displayName' | 'logo'>>,
): ConnectorMetadata {
  return { ...DEFAULTS, ...overrides };
}
