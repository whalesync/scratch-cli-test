'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { Text13Medium } from '@/app/components/base/text';
import { useSettingsReturnPathSessionStorage } from '@/hooks/use-settings-return-path-session-storage';
import { RouteUrls } from '@/utils/route-urls';
import { safeSettingsReturnPath } from '@/utils/settings-return-path';
import { Box, Group, UnstyledButton } from '@mantine/core';
import { ArrowLeftIcon, SettingsIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';

export function SettingsHeader() {
  const router = useRouter();
  const [returnPath] = useSettingsReturnPathSessionStorage();

  const goBack = () => {
    const target = safeSettingsReturnPath(returnPath);
    if (target !== null) {
      router.push(target);
      return;
    }
    router.push(RouteUrls.homePageUrl);
  };

  return (
    <Box
      px="sm"
      py="xs"
      style={{
        borderBottom: '1px solid var(--fg-divider)',
      }}
    >
      <Group gap="xs">
        <UnstyledButton
          type="button"
          aria-label="Go back"
          onClick={goBack}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 24,
            height: 24,
            borderRadius: 4,
          }}
        >
          <StyledLucideIcon Icon={ArrowLeftIcon} size="sm" c="var(--fg-muted)" />
        </UnstyledButton>
        <Group gap={6}>
          <StyledLucideIcon Icon={SettingsIcon} size="sm" c="var(--fg-muted)" />
          <Text13Medium c="var(--fg-primary)">Settings</Text13Medium>
        </Group>
      </Group>
    </Box>
  );
}
