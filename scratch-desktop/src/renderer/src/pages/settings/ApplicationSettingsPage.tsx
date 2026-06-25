import { Text12Book, TextMono13Regular } from '@/components/base/text';
import { Box, ScrollArea, Stack } from '@mantine/core';
import { AppWindowIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { SettingsInfoRow, SettingsPageHeader, SettingsSection } from './SettingsSection';

/**
 * Application sub-section of the desktop Settings view — local application info/config. Minimal for now (app
 * version); deeper application settings (update channel, CLI install, etc.) are deferred to a later ticket.
 */
export function ApplicationSettingsPage() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void window.scratchDesktop.getAppVersion().then((value) => {
      if (!cancelled) setVersion(value);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Stack h="100%" gap={0}>
      <SettingsPageHeader Icon={AppWindowIcon} title="Application" />
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Box p="md">
          <Stack gap="20px" maw={800}>
            <SettingsSection title="About" description="Application information">
              <SettingsInfoRow label="Version">
                <TextMono13Regular>{version ?? '—'}</TextMono13Regular>
              </SettingsInfoRow>
            </SettingsSection>
            <Text12Book c="dimmed">More application settings are coming soon.</Text12Book>
          </Stack>
        </Box>
      </ScrollArea>
    </Stack>
  );
}
