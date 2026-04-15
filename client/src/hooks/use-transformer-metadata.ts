import { SWR_KEYS } from '@/lib/api/keys';
import { transformerMetadataApi } from '@/lib/api/transformer-metadata';
import { TransformerMetadata } from '@spinner/shared-types';
import useSWR from 'swr';

export const useTransformerMetadata = () => {
  const { data, error, isLoading } = useSWR<TransformerMetadata[], Error>(
    SWR_KEYS.transformerMetadata.all(),
    () => transformerMetadataApi.getAll(),
    { revalidateOnFocus: false },
  );

  return {
    metadata: data,
    isLoading,
    error,
  };
};
