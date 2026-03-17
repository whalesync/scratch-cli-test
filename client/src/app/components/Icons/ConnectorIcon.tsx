import { getLogo, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { Image, MantineSpacing, StyleProp } from '@mantine/core';
import { Service } from '@spinner/shared-types';
import { ImageProps } from 'next/image';

export function ConnectorIcon(
  props: { connector: string | null; size?: number; p?: StyleProp<MantineSpacing> } & Omit<
    ImageProps,
    'src' | 'alt'
  > & {
      withBorder?: boolean;
    },
) {
  const { connector, size, withBorder, p, ...rest } = props;
  const { metadata } = useConnectorsMetadata();
  const iconUrl = getLogo(metadata, connector as Service);

  return (
    <Image
      src={iconUrl}
      w={size ?? 40}
      h={size ?? 40}
      alt={connector || 'Connector icon'}
      bd={withBorder ? '0.5px solid var(--mantine-color-gray-4)' : 'none'}
      bg={withBorder ? 'var(--bg-base)' : 'transparent'}
      p={p ?? '3.5px'}
      {...rest}
    />
  );
}
