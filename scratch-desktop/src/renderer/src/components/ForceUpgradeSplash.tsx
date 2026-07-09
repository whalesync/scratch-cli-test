import { Box, Paper, Progress, Stack } from '@mantine/core';
import { ArrowUpCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { UpdaterEvent } from '../../../shared/updater-events';
import logoColor from '../assets/logo-color.svg';
import { trackForceUpgradeRequired, trackInstallUpdate } from '../lib/posthog';
import { ButtonPrimaryLight } from './base/buttons';
import { Text13Regular, TextMono12Regular, TextTitle3 } from './base/text';
import { StyledLucideIcon } from './icons/StyledLucideIcon';

/**
 * Full-screen, blocking lock screen shown when the running desktop build is older
 * than the server-declared minimum supported version (DEV-10735). It replaces the
 * entire app UI — there is no way past it except updating — and drives the
 * existing `electron-updater` install-in-place flow: it kicks off a check on
 * mount, mirrors the download progress, and swaps to a "Restart & install" action
 * once the update has downloaded.
 */
type UpgradePhase = 'idle' | 'checking' | 'downloading' | 'downloaded' | 'unavailable' | 'error';

interface ForceUpgradeSplashProps {
  currentVersion: string | null;
  minimumVersion: string | null;
}

export function ForceUpgradeSplash({ currentVersion, minimumVersion }: ForceUpgradeSplashProps) {
  const [phase, setPhase] = useState<UpgradePhase>('idle');
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasStartedInitialCheck = useRef(false);

  // Mirror main-process updater events into a local phase state machine.
  useEffect(() => {
    const updaterApi = window.scratchDesktop?.updater;
    if (!updaterApi) {
      return;
    }
    const unsubscribe = updaterApi.subscribe((event: UpdaterEvent) => {
      console.debug('[force-upgrade] updater event', event);
      switch (event.type) {
        case 'checking-for-update':
          setPhase('checking');
          setErrorMessage(null);
          return;
        case 'update-available':
          setPhase('downloading');
          setDownloadPercent(0);
          return;
        case 'download-progress':
          setPhase('downloading');
          setDownloadPercent(Math.round(event.percent));
          return;
        case 'update-downloaded':
          setPhase('downloaded');
          return;
        case 'update-not-available':
          // Server says we're too old, but the update feed has nothing newer to
          // offer yet (release still propagating). Let the user retry.
          setPhase('unavailable');
          return;
        case 'error':
          setPhase('error');
          setErrorMessage(event.message);
          return;
      }
    });
    return unsubscribe;
  }, []);

  // Kick off a check automatically so the update usually starts downloading
  // before the user even reaches for the button.
  useEffect(() => {
    if (hasStartedInitialCheck.current) {
      return;
    }
    hasStartedInitialCheck.current = true;
    void trackForceUpgradeRequired({
      currentVersion: currentVersion ?? 'unknown',
      minimumVersion: minimumVersion ?? 'unknown',
    });
    setPhase('checking');
    void window.scratchDesktop?.updater.checkNow();
  }, [currentVersion, minimumVersion]);

  const handlePrimaryAction = (): void => {
    if (phase === 'downloaded') {
      void trackInstallUpdate({ targetVersion: minimumVersion ?? 'unknown' });
      void window.scratchDesktop?.updater.quitAndInstall();
      return;
    }
    // idle / unavailable / error → (re)check for the update.
    setErrorMessage(null);
    setPhase('checking');
    void window.scratchDesktop?.updater.checkNow();
  };

  const isBusy = phase === 'checking' || phase === 'downloading';
  const primaryLabel = ((): string => {
    switch (phase) {
      case 'checking':
        return 'Checking for updates…';
      case 'downloading':
        return `Downloading… ${downloadPercent}%`;
      case 'downloaded':
        return 'Restart & install';
      case 'unavailable':
        return 'Check again';
      case 'error':
        return 'Try again';
      case 'idle':
      default:
        return 'Update now';
    }
  })();

  const statusMessage = ((): string | null => {
    if (phase === 'error') {
      return errorMessage ?? 'Something went wrong while updating. Please try again.';
    }
    if (phase === 'unavailable') {
      return "A newer version isn't available to download just yet. Please try again in a few minutes.";
    }
    if (phase === 'downloaded') {
      return 'The update is ready. Restart Scratch to finish installing — your workspaces will reopen.';
    }
    return null;
  })();

  return (
    <Box
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        height: '100vh',
        padding: 20,
        backgroundColor: 'var(--bg-base)',
      }}
    >
      <Paper p="xl" radius="md" maw={460} w="100%" withBorder={false}>
        <Stack gap="lg" align="center">
          <img src={logoColor} alt="Scratch" width={64} height={64} />
          <StyledLucideIcon Icon={ArrowUpCircle} size="lg" c="dimmed" />
          <TextTitle3 ta="center">Update required to continue</TextTitle3>
          <Text13Regular c="dimmed" ta="center">
            This version of Scratch is no longer supported. Update to the latest version to keep working — it only takes
            a moment and your workspaces will reopen.
          </Text13Regular>
          {(currentVersion || minimumVersion) && (
            <TextMono12Regular c="dimmed" ta="center">
              {currentVersion ? `Current v${currentVersion}` : 'Current version unknown'}
              {minimumVersion ? ` · Required v${minimumVersion} or newer` : ''}
            </TextMono12Regular>
          )}
          {phase === 'downloading' && (
            <Progress value={downloadPercent} w="100%" size="sm" radius="xl" animated aria-label="Update download" />
          )}
          {statusMessage && (
            <Text13Regular c={phase === 'error' ? 'red' : 'dimmed'} ta="center">
              {statusMessage}
            </Text13Regular>
          )}
          <ButtonPrimaryLight onClick={handlePrimaryAction} loading={isBusy} disabled={isBusy} fullWidth>
            {primaryLabel}
          </ButtonPrimaryLight>
        </Stack>
      </Paper>
    </Box>
  );
}
