import type { ConnectorMetadata } from '@spinner/shared-types';
import { API_CONFIG } from './api';

export type ConnectorsMetadataMap = Record<string, ConnectorMetadata>;

export const connectorsMetadataApi = {
  getAll: async (): Promise<ConnectorsMetadataMap> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<ConnectorsMetadataMap>('/connectors/metadata');
    return res.data;
  },
};
