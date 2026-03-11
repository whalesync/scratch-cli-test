import { useMantineTheme } from '@mantine/core';
import styles from './Clerk.module.css';

export const useClerkAppearance = (): ClerkAppearanceRegistry['theme'] => {
  const theme = useMantineTheme();

  return {
    variables: {
      colorPrimary: theme.colors.blue[9],
      colorDanger: theme.colors.red[9],
      colorSuccess: theme.colors.green[9],
      colorInputText: theme.colors.gray[11],
      colorText: theme.colors.gray[11],
      colorTextSecondary: theme.colors.gray[10],
    },
    elements: {
      rootBox: styles.rootBox,
      cardBox: styles.cardBox,
      card: styles.card,
      footer: styles.footer,
      footerActionLink: styles.footerActionLink,
      formButtonPrimary: styles.formButtonPrimary,
    },
  };
};
