import { Anchor, Box, Group } from '@mantine/core';
import { ScratchPlanType } from '@spinner/shared-types';
import { Outlet } from 'react-router-dom';
import { useCurrentUser } from '../hooks/use-current-user';
import { Text13Regular } from './base/text';

function TrialBanner() {
  const { user } = useCurrentUser();
  const sub = user?.subscription;
  console.log('PLAN', sub);
  const showBanner = !sub || sub.status === 'none' || sub.isTrial || sub.planType === ScratchPlanType.FREE_PLAN;
  if (!showBanner) return null;

  const webUrl = (import.meta.env.VITE_SCRATCH_WEB_URL as string) || 'http://localhost:3000';
  const billingUrl = `${webUrl}/settings/billing`;

  return (
    <Group
      h={32}
      px="md"
      gap="xs"
      align="center"
      style={{
        flexShrink: 0,
        borderBottom: '1px solid var(--mantine-color-default-border)',
        background: 'color-mix(in srgb, var(--mantine-primary-color-filled) 4%, var(--mantine-color-body))',
      }}
    >
      <Text13Regular c="var(--fg-secondary)">
        You&apos;re on the Scratch free trial.{' '}
        <Anchor
          component="button"
          fz="13px"
          fw={425}
          underline="hover"
          onClick={() => void window.scratchAuth.openExternal(billingUrl)}
        >
          Subscribe
        </Anchor>
      </Text13Regular>
    </Group>
  );
}

export function Layout() {
  return (
    <Box h="100vh" style={{ display: 'flex', flexDirection: 'column' }}>
      <TrialBanner />
      <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </Box>
    </Box>
  );
}
