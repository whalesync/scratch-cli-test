import { notifications } from '@mantine/notifications';
import { useEffect } from 'react';
import type { CliInstallEvent } from '../../../shared/cli-install-events';

const NOTIFICATION_ID = 'cli-install-result';

/**
 * Subscribes to main-process CLI install events and surfaces them via Mantine
 * notifications. Renders no UI of its own.
 */
export function CliInstallProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const api = window.scratchDesktop?.cliInstall;
    if (!api) {
      return;
    }

    const unsubscribe = api.subscribe((event: CliInstallEvent) => {
      // Reuse the same notification id so a rapid click-again replaces the
      // previous toast rather than stacking.
      notifications.hide(NOTIFICATION_ID);
      switch (event.type) {
        case 'installed':
          notifications.show({
            id: NOTIFICATION_ID,
            title: 'Command Line Tools installed',
            message: 'Open a new terminal to pick up the change.',
            color: 'green',
            autoClose: 6000,
            withCloseButton: true,
          });
          return;
        case 'uninstalled':
          notifications.show({
            id: NOTIFICATION_ID,
            title: 'Command Line Tools uninstalled',
            message: 'Removed /usr/local/bin/scratchmd.',
            color: 'green',
            autoClose: 5000,
            withCloseButton: true,
          });
          return;
        case 'failed':
          notifications.show({
            id: NOTIFICATION_ID,
            title: 'Could not install Command Line Tools',
            message: event.message,
            color: 'red',
            autoClose: 8000,
            withCloseButton: true,
          });
          return;
      }
    });

    return unsubscribe;
  }, []);

  return <>{children}</>;
}
