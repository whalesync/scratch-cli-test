import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { SCRATCHPAD_MANTINE_THEME } from '../theme/theme';

export function AppMantineProvider({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider theme={SCRATCHPAD_MANTINE_THEME} defaultColorScheme="light">
      <Notifications />
      {children}
    </MantineProvider>
  );
}
