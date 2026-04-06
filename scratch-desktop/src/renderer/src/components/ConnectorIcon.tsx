import { Image } from '@mantine/core';

/** Remote connector logo; mirrors the web client `ConnectorIcon` styling. */
export function ConnectorIcon({ connector, src, size = 22 }: { connector: string | null; src: string; size?: number }) {
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
