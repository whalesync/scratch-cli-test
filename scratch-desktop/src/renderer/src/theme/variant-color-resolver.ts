import { VariantColorsResolver, defaultVariantColorsResolver, parseThemeColor } from '@mantine/core';

export const variantColorResolver: VariantColorsResolver = (input) => {
  const defaultResolvedColors = defaultVariantColorsResolver(input);
  const parsedColor = parseThemeColor({
    color: input.color || input.theme.primaryColor,
    theme: input.theme,
  });

  if (input.variant === 'transparent-hover') {
    return {
      ...defaultResolvedColors,
      color: parsedColor.color,
    };
  }

  return defaultResolvedColors;
};
