import { Text13Regular, TextTitle4 } from '@/components/base/text';
import { trackAutoDownloadSettingChanged } from '@/lib/posthog';
import { Group, Stack, Switch } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useEffect, useState } from 'react';

interface AutoDownloadSettingsProps {
  workbookId: string;
}

/**
 * DEV-10470: per-workspace toggle for the scheduled daily auto-download. When
 * on (the default), the desktop app re-downloads this workspace's latest server
 * data automatically on app open and hourly — the automated equivalent of
 * clicking "Re-download files" every morning. The scheduler that acts on this
 * setting runs in the main process and reads it straight from electron-store, so
 * this component only needs to read/write the persisted preference.
 */
export function AutoDownloadSettings({ workbookId }: AutoDownloadSettingsProps) {
  // Default ON: absent/undefined means enabled. Start optimistically `true` so
  // the switch renders in its eventual state before the async read resolves.
  const [enabled, setEnabled] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.scratchPreferences.getWorkbookSettings(workbookId).then((settings) => {
      if (cancelled) return;
      setEnabled(settings.autoDownloadEnabled !== false);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [workbookId]);

  const handleToggle = async (next: boolean) => {
    const previous = enabled;
    setEnabled(next); // optimistic
    setSaving(true);
    try {
      await window.scratchPreferences.setWorkbookSetting(workbookId, 'autoDownloadEnabled', next);
      void trackAutoDownloadSettingChanged(workbookId, next);
    } catch (error) {
      setEnabled(previous); // roll back on failure
      notifications.show({
        title: 'Error',
        message: 'Failed to update automatic download setting',
        color: 'red',
      });
      console.debug('[auto-download] failed to persist setting:', error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Stack gap="md" px="md">
      <TextTitle4>Automatic updates</TextTitle4>
      <Group align="flex-start" justify="space-between" gap="md" wrap="nowrap">
        <Text13Regular c="dimmed" style={{ flex: 1 }}>
          Automatically download the latest data from Scratch once an hour (and when you open the app), so your local
          files are up to date when you sit down. Your local edits are preserved.
        </Text13Regular>
        <Switch
          checked={enabled}
          disabled={!loaded || saving}
          onChange={(e) => void handleToggle(e.currentTarget.checked)}
          label={enabled ? 'On' : 'Off'}
          size="md"
          styles={{ label: { paddingLeft: 8, fontSize: 13 } }}
          aria-label="Automatically download latest data daily"
        />
      </Group>
    </Stack>
  );
}
