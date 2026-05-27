import { getConnectorLogoUrl, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { Box } from '@mantine/core';

interface ConnectorIconProps {
  connector: string | null;
  size?: number;
  p?: number;
}

export function ConnectorIcon({ connector, size = 24, p = 0 }: ConnectorIconProps) {
  const { data: metadata } = useConnectorsMetadata();
  const logoUrl = getConnectorLogoUrl(metadata, connector);

  return (
    <Box
      style={{
        width: size,
        height: size,
        padding: p,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <img
        src={logoUrl}
        alt={connector ?? 'connector'}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />
    </Box>
  );
}
