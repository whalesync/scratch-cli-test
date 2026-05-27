import { Box, Image } from '@mantine/core';
import { PocketKnifeIcon } from 'lucide-react';

/** Remote connector logo; mirrors the web client `ConnectorIcon` styling. */
export function ConnectorIcon({ connector, src, size = 22 }: { connector: string | null; src: string; size?: number }) {
  if (connector === 'GENERIC_API') {
    return (
      <Box
        w={size}
        h={size}
        bd="0.5px solid var(--mantine-color-gray-4)"
        bg="var(--bg-base)"
        style={{
          borderRadius: 4,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PocketKnifeIcon size={size - 6} color="var(--mantine-color-gray-6)" />
      </Box>
    );
  }

  return (
    <Image
      src={src}
      w={size}
      h={size}
      alt={connector || 'Connector'}
      fit="contain"
      bd="0.5px solid var(--mantine-color-gray-4)"
      bg="var(--bg-base)"
      p={4}
      style={{ borderRadius: 4, flexShrink: 0 }}
    />
  );
}
