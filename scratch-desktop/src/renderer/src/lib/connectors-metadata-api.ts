import { API_CONFIG } from './api';

/** Subset of server `ConnectorMetadata` used by the desktop UI. */
export type ConnectorsMetadataMap = Record<string, { logo: string; incrementalPull?: boolean }>;

export const connectorsMetadataApi = {
  getAll: async (): Promise<ConnectorsMetadataMap> => {
    const axios = API_CONFIG.getAxiosInstance();
    const res = await axios.get<ConnectorsMetadataMap>('/connectors/metadata');
    return res.data;
  },
};
