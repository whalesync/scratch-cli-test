import { AuthMethod, ConnectorSettingDefinition } from '@spinner/shared-types';
import { API_CONFIG } from './api';

/** Server `ConnectorMetadata` shape returned by `GET /connectors/metadata`. */
export interface ConnectorMetadataEntry {
  displayName: string;
  logo: string;
  visible: boolean;
  incrementalPull: boolean;
  supportedAuthMethods: AuthMethod[];
  defaultAuthMethod: AuthMethod;
  oauth?: { label: string; privateLabel?: string };
  credentialFields?: Partial<Record<AuthMethod, ConnectorSettingDefinition[]>>;
  userProvidedParamsLabel?: string;
  setupGuide?: { label: string; url: string };
  table: string;
  tables: string;
  record: string;
  records: string;
  base: string | null;
  bases: string | null;
  pushOperationName: string;
  pullOperationName: string;
}

export type ConnectorsMetadataMap = Record<string, ConnectorMetadataEntry>;

export const connectorsMetadataApi = {
  getAll: async (): Promise<ConnectorsMetadataMap> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<ConnectorsMetadataMap>('/connectors/metadata');
    return res.data;
  },
};
