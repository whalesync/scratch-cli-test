import { getConnectorLogoUrl, useConnectorsMetadata } from '@/hooks/use-connectors-metadata';
import { Box } from '@mantine/core';
import { PocketKnifeIcon } from 'lucide-react';
import { useState } from 'react';

interface ConnectorIconProps {
  connector: string | null;
  size?: number;
  p?: number;
}

export function ConnectorIcon({ connector, size = 24, p = 0 }: ConnectorIconProps) {
  const { data: metadata } = useConnectorsMetadata();
  const logoUrl = getConnectorLogoUrl(metadata, connector);
  const [failed, setFailed] = useState(false);

  if (connector === 'GENERIC_API') {
    const iconSize = size - p * 2;
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
        <PocketKnifeIcon size={iconSize * 0.75} color="black" strokeWidth={1.5} />
      </Box>
    );
  }

  if (failed || !logoUrl) return null;

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
        onError={() => setFailed(true)}
      />
    </Box>
  );
}
