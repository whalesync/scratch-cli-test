'use client';

import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import { ConfigSection } from '@/app/components/ConfigSection';
import MainContent from '@/app/components/layouts/MainContent';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { ActionIcon, CopyButton, Group, PasswordInput, Stack, Switch, Tooltip } from '@mantine/core';
import { BlocksIcon, CheckIcon, CopyIcon, KeyIcon, RefreshCwIcon } from 'lucide-react';
import { useState } from 'react';

export default function IntegrationsSettingsPage() {
  const { user, refreshCurrentUser } = useScratchPadUser();
  const [isGenerating, setIsGenerating] = useState(false);
  const [isUpdatingPublish, setIsUpdatingPublish] = useState(false);
  const { open: openConfirmDialog, dialogProps } = useConfirmDialog();

  const cliCanPublish = user?.settings?.cliCanPublish === true;

  const generateToken = async () => {
    setIsGenerating(true);
    try {
      await scratchApiClient.users.generateApiToken();
      await refreshCurrentUser();
    } finally {
      setIsGenerating(false);
    }
  };

  const handleGenerateToken = () => {
    if (user?.apiToken) {
      openConfirmDialog({
        title: 'Regenerate API Key',
        message: 'This will invalidate your existing API key. Any integrations using it will stop working. Continue?',
        confirmLabel: 'Regenerate',
        variant: 'danger',
        onConfirm: generateToken,
      });
    } else {
      generateToken();
    }
  };

  const handleToggleCliPublish = async (checked: boolean) => {
    setIsUpdatingPublish(true);
    try {
      await scratchApiClient.users.updateSettings({ updates: { cliCanPublish: checked } });
      await refreshCurrentUser();
    } finally {
      setIsUpdatingPublish(false);
    }
  };

  return (
    <MainContent>
      <MainContent.BasicHeader title="Integrations" Icon={BlocksIcon} />
      <MainContent.Body>
        <Stack gap="20px" maw={800}>
          <ConfigSection title="API Key" description="Use this key to authenticate with the Scratch API.">
            {user?.apiToken ? (
              <Group wrap="nowrap" gap="xs">
                <PasswordInput variant="unstyled" value={user.apiToken} placeholder="No API key" readOnly flex={1} />
                <CopyButton value={user.apiToken} timeout={2000}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied' : 'Copy API key'} withArrow position="right">
                      <ActionIcon color={copied ? 'teal' : 'gray'} variant="subtle" onClick={copy}>
                        {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
                <Tooltip label="Regenerate API key">
                  <ActionIcon variant="subtle" color="gray" onClick={handleGenerateToken} loading={isGenerating}>
                    <RefreshCwIcon size={16} />
                  </ActionIcon>
                </Tooltip>
              </Group>
            ) : (
              <ButtonPrimarySolid
                size="xs"
                leftSection={<KeyIcon size={16} />}
                onClick={handleGenerateToken}
                loading={isGenerating}
              >
                Generate API Key
              </ButtonPrimarySolid>
            )}
          </ConfigSection>

          <ConfigSection
            title="Allow CLI to publish changes"
            description="When enabled, changes from the CLI will bypass the Review stage and go live to your connected services immediately."
          >
            <Switch
              checked={cliCanPublish}
              onChange={(event) => handleToggleCliPublish(event.currentTarget.checked)}
              disabled={isUpdatingPublish}
              label={cliCanPublish ? 'Enabled' : 'Disabled'}
            />
          </ConfigSection>
        </Stack>
      </MainContent.Body>

      {/* Confirm Dialog */}
      <ConfirmDialog {...dialogProps} />
    </MainContent>
  );
}
