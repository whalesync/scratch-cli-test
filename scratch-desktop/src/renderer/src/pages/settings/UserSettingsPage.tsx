import { ButtonSecondaryOutline } from '@/components/base/buttons';
import { Text13Regular, TextMono13Regular } from '@/components/base/text';
import { StyledLucideIcon } from '@/components/icons/StyledLucideIcon';
import { useCurrentUser } from '@/hooks/use-current-user';
import { useAuth } from '@/providers/AuthProvider';
import { Box, Group, ScrollArea, Stack } from '@mantine/core';
import { LogOutIcon, UserIcon } from 'lucide-react';
import { SettingsInfoRow, SettingsPageHeader, SettingsSection } from './SettingsSection';

/**
 * User sub-section of the desktop Settings view — the signed-in account's info plus a sign-out action.
 */
export function UserSettingsPage() {
  const { user } = useCurrentUser();
  const { logout } = useAuth();

  return (
    <Stack h="100%" gap={0}>
      <SettingsPageHeader Icon={UserIcon} title="User" />
      <ScrollArea style={{ flex: 1, minHeight: 0 }}>
        <Box p="md">
          <Stack gap="20px" maw={800}>
            <SettingsSection title="Account" description="Your Scratch account">
              <Stack gap={0}>
                <SettingsInfoRow label="Email">
                  <Text13Regular>{user?.email ?? '—'}</Text13Regular>
                </SettingsInfoRow>
                <SettingsInfoRow label="User ID">
                  <TextMono13Regular>{user?.id ?? '—'}</TextMono13Regular>
                </SettingsInfoRow>
              </Stack>
            </SettingsSection>
            <Group>
              <ButtonSecondaryOutline
                leftSection={<StyledLucideIcon Icon={LogOutIcon} size={16} />}
                onClick={() => void logout()}
              >
                Sign out
              </ButtonSecondaryOutline>
            </Group>
          </Stack>
        </Box>
      </ScrollArea>
    </Stack>
  );
}
