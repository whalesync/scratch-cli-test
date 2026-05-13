import { Group, Stack } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useRef } from 'react';
import type { UpdaterEvent } from '../../../shared/updater-events';
import { ButtonPrimaryLight, ButtonSecondaryGhost } from '../components/base/buttons';
import { Text13Regular } from '../components/base/text';
import { trackCheckForUpdates, trackInstallUpdate } from '../lib/posthog';

const UPDATE_DOWNLOADED_NOTIFICATION_ID = 'updater-update-downloaded';
const MANUAL_CHECK_NOTIFICATION_ID = 'updater-manual-check';

/**
 * Subscribes to main-process updater events and surfaces them via Mantine
 * notifications. Renders no UI of its own.
 *
 * Behavior:
 * - Auto checks: silent except for the persistent "Restart & install" toast
 *   when an update finishes downloading.
 * - Manual checks (Help > Check for Updates…): show a transient toast for
 *   "checking", "no update", and errors; reuse the persistent toast for
 *   "downloaded".
 */
export function UpdaterProvider({ children }: { children: React.ReactNode }) {
  // Avoids stacking multiple "Restart & install" toasts if events arrive twice.
  const updateDownloadedRef = useRef(false);

  useEffect(() => {
    const updaterApi = window.scratchDesktop?.updater;
    if (!updaterApi) {
      return;
    }

    // Mantine's `notifications.update` is a no-op when the target id doesn't
    // exist yet. The mac path skips 'checking-for-update' and goes straight to
    // 'error', so we hide-then-show to reliably surface the manual-check toast
    // regardless of which event arrived first.
    function showManualToast(opts: Parameters<typeof notifications.show>[0]): void {
      notifications.hide(MANUAL_CHECK_NOTIFICATION_ID);
      notifications.show({ ...opts, id: MANUAL_CHECK_NOTIFICATION_ID });
    }

    const unsubscribe = updaterApi.subscribe((event: UpdaterEvent) => {
      console.debug('[updater] event', event);
      switch (event.type) {
        case 'checking-for-update': {
          if (event.manual) {
            void trackCheckForUpdates();
            showManualToast({
              title: 'Checking for updates…',
              message: '',
              loading: true,
              autoClose: false,
              withCloseButton: false,
            });
          }
          return;
        }
        case 'update-available': {
          if (event.manual) {
            showManualToast({
              title: 'Update found',
              message: `Downloading version ${event.version}…`,
              loading: true,
              autoClose: 4000,
              withCloseButton: true,
            });
          }
          return;
        }
        case 'update-not-available': {
          if (event.manual) {
            showManualToast({
              title: "You're up to date",
              message: `Running version ${event.version}.`,
              color: 'green',
              loading: false,
              autoClose: 4000,
              withCloseButton: true,
            });
          }
          return;
        }
        case 'download-progress': {
          // Keep v1 boring: no progress bar. Delta downloads are usually small.
          return;
        }
        case 'update-downloaded': {
          if (updateDownloadedRef.current) {
            return;
          }
          updateDownloadedRef.current = true;
          notifications.show({
            id: UPDATE_DOWNLOADED_NOTIFICATION_ID,
            title: `Update ready (v${event.version})`,
            message: (
              <Stack gap="xs" my="xs">
                <Text13Regular c="var(--fg-secondary)">
                  Restart Scratch to finish installing. Your workspaces will reopen.
                </Text13Regular>
                <Group gap="xs">
                  <ButtonPrimaryLight
                    onClick={() => {
                      void trackInstallUpdate({ targetVersion: event.version });
                      void window.scratchDesktop?.updater.quitAndInstall();
                    }}
                  >
                    Restart &amp; install
                  </ButtonPrimaryLight>
                  <ButtonSecondaryGhost
                    onClick={() => {
                      notifications.hide(UPDATE_DOWNLOADED_NOTIFICATION_ID);
                    }}
                  >
                    Later
                  </ButtonSecondaryGhost>
                </Group>
              </Stack>
            ),
            color: 'green',
            autoClose: false,
            withCloseButton: true,
            onClose: () => {
              updateDownloadedRef.current = false;
            },
          });
          return;
        }
        case 'error': {
          // Check-phase auto errors stay quiet — they're noisy on flaky
          // networks and the next scheduled check will retry. Download-phase
          // errors always surface: an update was found, the user has a
          // pending install, and silently dropping it means they sit on an
          // old version with no signal anything went wrong.
          if (event.phase === 'download') {
            showManualToast({
              title: 'Update download failed',
              message: event.message,
              color: 'red',
              loading: false,
              autoClose: 6000,
              withCloseButton: true,
            });
          } else if (event.manual) {
            showManualToast({
              title: 'Update check failed',
              message: event.message,
              color: 'red',
              loading: false,
              autoClose: 6000,
              withCloseButton: true,
            });
          }
          return;
        }
      }
    });

    return unsubscribe;
  }, []);

  return <>{children}</>;
}
