import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { TransformerMetadata } from '@spinner/shared-types';
import useSWR from 'swr';

export const useTransformerMetadata = () => {
  const { data, error, isLoading } = useSWR<TransformerMetadata[], Error>(
    SWR_KEYS.transformerMetadata.all(),
    () => scratchApiClient.transformerMetadata.getAll(),
    { revalidateOnFocus: false },
  );

  return {
    metadata: data,
    isLoading,
    error,
  };
};
