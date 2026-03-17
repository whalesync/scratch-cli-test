import { ConnectorMetadata, Service } from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const connectorsMetadataApi = {
  getAll: async (): Promise<Record<Service, ConnectorMetadata>> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<Record<Service, ConnectorMetadata>>('/connectors/metadata');
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch connector metadata');
    }
  },
};
