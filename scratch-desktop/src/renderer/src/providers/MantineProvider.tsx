import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { SCRATCH_MANTINE_THEME } from '../theme/theme';

export function AppMantineProvider({ children }: { children: React.ReactNode }) {
  return (
    <MantineProvider theme={SCRATCH_MANTINE_THEME} defaultColorScheme="light">
      <Notifications />
      {children}
    </MantineProvider>
  );
}
