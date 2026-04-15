import { TransformerMetadata } from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const transformerMetadataApi = {
  getAll: async (): Promise<TransformerMetadata[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<TransformerMetadata[]>('/sync/transformers/metadata');
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch transformer metadata');
    }
  },
};
