import { Badge } from '@/app/components/base/badge';
import { ButtonPrimarySolid, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text12Book, Text12Regular, Text13Regular } from '@/app/components/base/text';
import { ConfigSection } from '@/app/components/ConfigSection';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { getSessionId, getSessionRecordingStatus, getSessionReplayUrl } from '@/lib/posthog';
import { FLAGS, LocalStorageFlag } from '@/utils/flags-dev';
import { BUILD_VERSION } from '@/version';
import { ActionIcon, Checkbox, CopyButton, Divider, Grid, Group, PasswordInput, Stack, Tooltip } from '@mantine/core';
import { CheckIcon, CopyIcon, KeyIcon, PlayIcon, RefreshCwIcon } from 'lucide-react';
import { Fragment, JSX, useState } from 'react';

export const UserDevToolsSection = () => {
  const { user } = useScratchPadUser();

  return (
    <ConfigSection title="Dev Tools" description="Developer tools and information.">
      <Stack gap="xs">
        <Group wrap="nowrap" gap="xs">
          <Text13Regular miw={150}>Clerk ID</Text13Regular>
          <Text13Regular>{user?.clerkId || 'No clerk ID found'}</Text13Regular>
          <CopyButton value={user?.clerkId || ''} timeout={2000}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : `${user?.clerkId}`} withArrow position="right">
                <ActionIcon color={copied ? 'teal' : 'gray'} variant="subtle" onClick={copy}>
                  {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>

        <Group wrap="nowrap" gap="xs">
          <Text13Regular miw={150}>UI Websocket Key</Text13Regular>
          <PasswordInput
            variant="unstyled"
            value={user?.websocketToken}
            placeholder="No API key found"
            readOnly
            inputWrapperOrder={['input', 'label', 'description', 'error']}
            flex={1}
          />
          <CopyButton value={user?.websocketToken || ''} timeout={2000}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : `Copy UI Websocket API key`} withArrow position="right">
                <ActionIcon color={copied ? 'teal' : 'gray'} variant="subtle" onClick={copy}>
                  {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
        <Divider />
        <Group wrap="nowrap" gap="xs" align="flex-start">
          <Text13Regular miw={150}>Feature Flags</Text13Regular>
          <Grid w="100%">
            {user?.experimentalFlags &&
              Object.entries(user.experimentalFlags).map(([flag, value]) => (
                <Fragment key={flag}>
                  <Grid.Col span={4}>
                    <Text12Book>{flag}</Text12Book>
                  </Grid.Col>
                  <Grid.Col span={8}>
                    <Text12Regular
                      style={{ wordBreak: 'break-word', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}
                    >
                      {value.toString()}
                    </Text12Regular>
                  </Grid.Col>
                </Fragment>
              ))}
          </Grid>
        </Group>
        <Divider />
        <Group wrap="nowrap" gap="xs" align="flex-start">
          <Text13Regular miw={150}>Local Flags</Text13Regular>
          <Grid w="100%">
            <Grid.Col span={4}>
              <Text12Regular>Dev tools visible</Text12Regular>
            </Grid.Col>
            <Grid.Col span={8}>
              <FlagCheckboxOption flag={FLAGS.DEV_TOOLS_VISIBLE} />
            </Grid.Col>
          </Grid>
        </Group>
        <Divider />
        <Group wrap="nowrap" gap="xs" align="flex-start">
          <Text13Regular miw={150}>User Settings</Text13Regular>
          <Grid w="100%">
            {user?.settings &&
              Object.entries(user.settings).map(([key, value]) => (
                <Fragment key={key}>
                  <Grid.Col span={4}>
                    <Text12Regular>{key}</Text12Regular>
                  </Grid.Col>
                  <Grid.Col span={8}>
                    <Text12Regular>{value}</Text12Regular>
                  </Grid.Col>
                </Fragment>
              ))}
          </Grid>
        </Group>
        <Divider />
        <Group wrap="nowrap" gap="xs" align="flex-start">
          <Text13Regular miw={150}>PostHog Debug</Text13Regular>
          <Grid w="100%">
            <Grid.Col span={4}>
              <Text12Regular>Session ID</Text12Regular>
            </Grid.Col>
            <Grid.Col span={8}>
              <Text12Regular>{getSessionId()}</Text12Regular>
            </Grid.Col>
            <Grid.Col span={4}>
              <Text12Regular>Session Recording Status</Text12Regular>
            </Grid.Col>
            <Grid.Col span={8}>
              <Badge>{getSessionRecordingStatus()}</Badge>
            </Grid.Col>
            <Grid.Col span={4}>
              <Text12Regular>Session Replay URL</Text12Regular>
            </Grid.Col>
            <Grid.Col span={8}>
              <ButtonSecondaryOutline
                size="xs"
                w="fit-content"
                leftSection={<PlayIcon size={16} />}
                onClick={() => window.open(getSessionReplayUrl(), '_blank')}
              >
                View replay
              </ButtonSecondaryOutline>
            </Grid.Col>
          </Grid>
        </Group>
      </Stack>
    </ConfigSection>
  );
};

const FlagCheckboxOption = (props: { flag: LocalStorageFlag }): JSX.Element => {
  const [checked, setChecked] = useState(props.flag.getLocalStorageValue());
  return (
    <Checkbox
      checked={checked}
      onChange={(e) => {
        props.flag.setLocalStorageValue(e.currentTarget.checked);
        setChecked(e.currentTarget.checked);
        window.location.reload();
      }}
    />
  );
};

// Debug section with User ID and Build, visible even not in dev mode.
export const CurrentUserSection = () => {
  const { user, isAdmin } = useScratchPadUser();
  return (
    <ConfigSection title="Debug" description="Debug information for troubleshooting.">
      <Stack gap="xs">
        <Group wrap="nowrap" gap="xs">
          <Text13Regular miw={150}>User ID</Text13Regular>
          <Text13Regular>{user?.id || 'No user ID found'}</Text13Regular>
          <CopyButton value={user?.id || ''} timeout={2000}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : `${user?.id}`} withArrow position="right">
                <ActionIcon color={copied ? 'teal' : 'gray'} variant="subtle" onClick={copy}>
                  {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
          {isAdmin && <Badge>Admin</Badge>}
        </Group>
        <Group wrap="nowrap" gap="xs">
          <Text13Regular miw={150}>Build</Text13Regular>
          <Text13Regular>{BUILD_VERSION}</Text13Regular>
          <CopyButton value={BUILD_VERSION} timeout={2000}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? 'Copied' : BUILD_VERSION} withArrow position="right">
                <ActionIcon color={copied ? 'teal' : 'gray'} variant="subtle" onClick={copy}>
                  {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
      </Stack>
    </ConfigSection>
  );
};

// API Key section for generating and managing API tokens
export const ApiKeySection = () => {
  const { user, refreshCurrentUser } = useScratchPadUser();
  const [isGenerating, setIsGenerating] = useState(false);
  const { open: openConfirmDialog, dialogProps } = useConfirmDialog();

  const generateToken = async () => {
    setIsGenerating(true);
    try {
      await scratchApiClient.users.generateApiToken();
      await refreshCurrentUser(); // Refresh user data to get the new token
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

  return (
    <>
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

      {/* Confirm Dialog */}
      <ConfirmDialog {...dialogProps} />
    </>
  );
};
