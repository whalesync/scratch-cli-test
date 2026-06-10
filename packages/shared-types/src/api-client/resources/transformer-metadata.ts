import type { TransformerMetadata } from '../../transformer-metadata';
import type { Http } from '../http';

export function createTransformerMetadataApi(http: Http) {
  return {
    getAll: async (): Promise<TransformerMetadata[]> => {
      const res = await http.get<TransformerMetadata[]>('/sync/transformers/metadata', {
        fallbackMessage: 'Failed to fetch transformer metadata',
      });
      return res.data;
    },
  };
}

export type TransformerMetadataApi = ReturnType<typeof createTransformerMetadataApi>;
