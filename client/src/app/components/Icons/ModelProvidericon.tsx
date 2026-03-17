import { Image, MantineSpacing, StyleProp } from '@mantine/core';
import { ImageProps } from 'next/image';

interface ModelProvider {
  icon: string;
  patterns: string[];
}

const modelProviders: ModelProvider[] = [
  {
    icon: 'open-ai.svg',
    patterns: ['openai'],
  },
  {
    icon: 'gemini.svg',
    patterns: ['google'],
  },
  {
    icon: 'meta.svg',
    patterns: ['meta', 'meta-ai', 'meta-llama'],
  },
  {
    icon: 'ai21.svg',
    patterns: ['ai21', 'ai21-labs'],
  },
  {
    icon: 'aion.svg',
    patterns: ['aion', 'aion-labs'],
  },
  {
    // icon: 'anthropic.svg', // TODO: waiting on this icon
    icon: 'open-router.svg',
    patterns: ['anthropic', 'claude'],
  },
  {
    // icon: 'x-ai.svg', // TODO: waiting on this icon
    icon: 'open-router.svg',
    patterns: ['xai', 'x-ai'],
  },
  {
    icon: 'scratch.svg',
    patterns: ['scratch'],
  },
  {
    icon: 'open-router.svg',
    patterns: ['open-router'],
  },
];

function getModelIconPath(modelName: string | null | undefined): string {
  if (!modelName) {
    return 'https://static.scratch.md/model-icons/open-router.svg';
  }

  // Extract the prefix (part before the first "/")
  const prefix = modelName.split('/')[0]?.toLowerCase() || '';

  const provider = modelProviders.find((provider) => provider.patterns.includes(prefix));

  if (!provider) {
    return 'https://static.scratch.md/model-icons/open-router.svg';
  }

  return `https://static.scratch.md/model-icons/${provider.icon}`;
}

export function ModelProviderIcon(
  props: { model: string | null; size?: number; p?: StyleProp<MantineSpacing> } & Omit<ImageProps, 'src' | 'alt'> & {
      withBorder?: boolean;
    },
) {
  const { model, size, withBorder, p, ...rest } = props;
  const iconUrl = getModelIconPath(model);

  return (
    <Image
      src={iconUrl}
      w={size ?? 40}
      h={size ?? 40}
      alt={model || 'Model icon'}
      bd={withBorder ? '0.5px solid var(--mantine-color-gray-4)' : 'none'}
      bg={withBorder ? 'var(--bg-base)' : 'transparent'}
      p={p ?? '3.5px'}
      {...rest}
    />
  );
}
