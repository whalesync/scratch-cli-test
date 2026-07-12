import { Box, Collapse, Paper, Progress, ScrollArea, Stack } from '@mantine/core';
import { ArrowUpCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { UpdaterEvent } from '../../../shared/updater-events';
import logoColor from '../assets/logo-color.svg';
import { trackForceUpgradeRequired, trackInstallUpdate } from '../lib/posthog';
import { ButtonPrimaryLight, ButtonSecondaryInline } from './base/buttons';
import { Text13Regular, TextMono12Regular, TextMono9Regular, TextTitle3 } from './base/text';
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
  const [showErrorDetails, setShowErrorDetails] = useState(false);
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
          setShowErrorDetails(false);
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
    setShowErrorDetails(false);
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
      // Keep this human — the raw updater error (often a multi-line HTTP stack
      // trace) goes behind the "Show details" expando below, not here.
      return "We couldn't reach the update service. Please try again in a moment.";
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
          {phase === 'error' && errorMessage && (
            <Stack gap="xs" w="100%" align="center">
              <ButtonSecondaryInline onClick={() => setShowErrorDetails((shown) => !shown)}>
                {showErrorDetails ? 'Hide details' : 'Show details'}
              </ButtonSecondaryInline>
              <Collapse in={showErrorDetails} w="100%">
                <ScrollArea.Autosize mah={140} type="auto">
                  <TextMono9Regular c="dimmed" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {errorMessage}
                  </TextMono9Regular>
                </ScrollArea.Autosize>
              </Collapse>
            </Stack>
          )}
          <ButtonPrimaryLight onClick={handlePrimaryAction} loading={isBusy} disabled={isBusy} fullWidth>
            {primaryLabel}
          </ButtonPrimaryLight>
        </Stack>
      </Paper>
    </Box>
  );
}
