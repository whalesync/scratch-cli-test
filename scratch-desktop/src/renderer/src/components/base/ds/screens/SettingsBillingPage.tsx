// Faithful reproduction of the desktop app's Billing settings page — usage, active subscription, and
// the upgrade plan cards, inside the settings shell. Self-contained; no IPC. From the real
// BillingSettingsPage source (DEV-10592).
import { Box, Divider, Group, Progress, SimpleGrid, Stack } from '@mantine/core';
import { Check, CreditCard } from 'lucide-react';
import { ButtonPrimarySolid, ButtonSecondaryOutline } from '../../buttons';
import { Text12Regular, Text13Regular, TextTitle1, TextTitle4 } from '../../text';
import { SettingsShell } from './settings-shell';

function PlanCard({
  name,
  price,
  features,
  cta,
  highlighted,
}: {
  name: string;
  price: string;
  features: string[];
  cta: string;
  highlighted?: boolean;
}) {
  return (
    <Stack
      gap={12}
      p={16}
      style={{
        border: `1px solid ${highlighted ? 'var(--highlight-border)' : 'var(--fg-divider)'}`,
        borderRadius: 8,
        background: highlighted ? 'var(--highlight-fill)' : 'var(--bg-base)',
      }}
    >
      <Box>
        <TextTitle4>{name}</TextTitle4>
        <Group gap={4} align="baseline" mt={4}>
          <TextTitle1 style={{ fontSize: 26 }}>{price}</TextTitle1>
          <Text12Regular c="var(--fg-muted)">/ month</Text12Regular>
        </Group>
      </Box>
      <Stack gap={6}>
        {features.map((f) => (
          <Group key={f} gap={6} wrap="nowrap">
            <Check size={14} color="var(--create-needs-review-stroke)" style={{ flex: 'none' }} />
            <Text13Regular c="var(--fg-secondary)">{f}</Text13Regular>
          </Group>
        ))}
      </Stack>
      {highlighted ? (
        <ButtonPrimarySolid fullWidth>{cta}</ButtonPrimarySolid>
      ) : (
        <ButtonSecondaryOutline fullWidth>{cta}</ButtonSecondaryOutline>
      )}
    </Stack>
  );
}

export function SettingsBillingPage() {
  return (
    <SettingsShell active="Billing" pageIcon={CreditCard} pageTitle="Billing">
      <Stack gap={20} style={{ maxWidth: 800 }}>
        {/* usage */}
        <Box>
          <TextTitle4>Usage</TextTitle4>
          <Group justify="space-between" mt={8} mb={4}>
            <Text13Regular c="var(--fg-secondary)">Records synced</Text13Regular>
            <Text13Regular c="var(--fg-primary)">1,407 / 5,000</Text13Regular>
          </Group>
          <Progress value={28} size="sm" color="green" />
        </Box>
        <Divider />
        {/* subscription */}
        <Box>
          <TextTitle4>Subscription</TextTitle4>
          <Group justify="space-between" mt={8}>
            <Group gap={8} align="center">
              <Text13Regular c="var(--fg-primary)">Free trial</Text13Regular>
              <Box
                style={{
                  padding: '1px 8px',
                  borderRadius: 4,
                  background: 'var(--highlight-fill)',
                  border: '1px solid var(--highlight-border)',
                }}
              >
                <Text12Regular c="var(--highlight-text)">Active</Text12Regular>
              </Box>
            </Group>
            <Text13Regular c="var(--fg-muted)">Renews Jul 12, 2026</Text13Regular>
          </Group>
        </Box>
        <Divider />
        {/* plans */}
        <Box>
          <TextTitle4>Plans</TextTitle4>
          <Text12Regular c="var(--fg-muted)" style={{ marginTop: 2, marginBottom: 12 }}>
            Upgrade or change your plan
          </Text12Regular>
          <SimpleGrid cols={2} spacing={12}>
            <PlanCard
              name="Pro"
              price="$29"
              features={['25,000 records', 'Unlimited connections', 'Priority support']}
              cta="Upgrade to Pro"
              highlighted
            />
            <PlanCard
              name="Max"
              price="$99"
              features={['250,000 records', 'Everything in Pro', 'Dedicated support']}
              cta="Upgrade to Max"
            />
          </SimpleGrid>
        </Box>
      </Stack>
    </SettingsShell>
  );
}
