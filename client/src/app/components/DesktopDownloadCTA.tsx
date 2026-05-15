'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text12Regular, Text16Regular, TextTitle2 } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { useDesktopRelease } from '@/hooks/use-desktop-release';
import { RouteUrls } from '@/utils/route-urls';
import { Box, Stack } from '@mantine/core';
import type { DesktopReleaseAsset } from '@spinner/shared-types';
import { DownloadIcon, MonitorIcon } from 'lucide-react';

function findMacDmg(assets: DesktopReleaseAsset[] | undefined): DesktopReleaseAsset | null {
  if (!assets) return null;
  const arm64 = assets.find((a) => /arm64.*\.dmg$/i.test(a.name));
  if (arm64) return arm64;
  return assets.find((a) => /\.dmg$/i.test(a.name)) ?? null;
}

interface DesktopDownloadCTAProps {
  /** Optional uppercase eyebrow shown above the logo (e.g. "// GET STARTED"). */
  eyebrow?: string;
}

export function DesktopDownloadCTA({ eyebrow }: DesktopDownloadCTAProps) {
  const { release, isLoading: isReleaseLoading } = useDesktopRelease();
  const macDmg = findMacDmg(release?.assets);

  return (
    <Stack align="center" gap="xl" maw={400} w="100%">
      {eyebrow && (
        <Text12Regular c="var(--mantine-color-green-7)" style={{ textTransform: 'uppercase' }}>
          {eyebrow}
        </Text12Regular>
      )}
      <Box
        style={{
          width: 80,
          height: 80,
          backgroundColor: '#9BF9EB',
          borderRadius: 16,
          backgroundImage: 'url(/logo-color.svg)',
          backgroundSize: 90,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'center',
        }}
      />
      <Stack align="center" gap="xs">
        <TextTitle2>Scratch</TextTitle2>
        <Text16Regular c="dimmed" ta="center">
          Download Scratch Desktop for the best experience managing your content.
        </Text16Regular>
      </Stack>
      <Stack gap="sm" w="100%">
        <ButtonPrimaryLight
          component="a"
          href={macDmg?.url ?? RouteUrls.downloadsPageUrl}
          leftSection={<StyledLucideIcon Icon={DownloadIcon} size="sm" />}
          fullWidth
          loading={isReleaseLoading}
          disabled={!isReleaseLoading && !macDmg}
        >
          Download for macOS
        </ButtonPrimaryLight>
        <ButtonSecondaryOutline
          component="a"
          href="scratch://"
          leftSection={<StyledLucideIcon Icon={MonitorIcon} size="sm" />}
          fullWidth
        >
          Open Scratch Desktop
        </ButtonSecondaryOutline>
      </Stack>
    </Stack>
  );
}
