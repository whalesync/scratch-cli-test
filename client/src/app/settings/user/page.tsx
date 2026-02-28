'use client';

import { Badge } from '@/app/components/base/badge';
import { Text13Regular } from '@/app/components/base/text';
import { ConfigSection } from '@/app/components/ConfigSection';
import MainContent from '@/app/components/layouts/MainContent';
import { useDevTools } from '@/hooks/use-dev-tools';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { BUILD_VERSION } from '@/version';
import { ActionIcon, Button, CopyButton, Group, Stack, Tooltip } from '@mantine/core';
import { CheckIcon, CopyIcon, UserIcon } from 'lucide-react';

export default function UserSettingsPage() {
  const { user, isAdmin } = useScratchPadUser();
  const { isDevToolsEnabled, showSecretButton, toggleDevToolsVisible } = useDevTools();

  return (
    <MainContent>
      <MainContent.BasicHeader title="User" Icon={UserIcon} />
      <MainContent.Body>
        <Stack gap="20px" maw={800}>
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
                <Text13Regular miw={150}>Client build</Text13Regular>
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
              <Group wrap="nowrap" gap="xs">
                <Text13Regular miw={150}>Server build</Text13Regular>
                <Text13Regular>{user?.serverBuildVersion || '—'}</Text13Regular>
                <CopyButton value={user?.serverBuildVersion || ''} timeout={2000}>
                  {({ copied, copy }) => (
                    <Tooltip label={copied ? 'Copied' : user?.serverBuildVersion || '—'} withArrow position="right">
                      <ActionIcon color={copied ? 'teal' : 'gray'} variant="subtle" onClick={copy}>
                        {copied ? <CheckIcon size={16} /> : <CopyIcon size={16} />}
                      </ActionIcon>
                    </Tooltip>
                  )}
                </CopyButton>
              </Group>
            </Stack>
          </ConfigSection>

          {showSecretButton && (
            <Tooltip label={isDevToolsEnabled ? 'Hide dev tools' : 'Show dev tools'}>
              <Button
                size="xs"
                variant="transparent"
                onClick={() => {
                  toggleDevToolsVisible();
                  window.location.reload();
                }}
                w="fit-content"
                color="white"
              >
                Toggle dev tools
              </Button>
            </Tooltip>
          )}
        </Stack>
      </MainContent.Body>
    </MainContent>
  );
}
