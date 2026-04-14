'use client';

import { ButtonPrimarySolid, ButtonSecondaryOutline, DevToolButtonGhost } from '@/app/components/base/buttons';
import { Text13Regular, Text16Regular, TextTitle3 } from '@/app/components/base/text';
import { FullPageLoader } from '@/app/components/FullPageLoader';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import MainContent from '@/app/components/layouts/MainContent';
import { useDesktopRelease } from '@/hooks/use-desktop-release';
import { useDevTools } from '@/hooks/use-dev-tools';
import { DesktopReleaseAsset, DesktopReleaseResponse } from '@spinner/shared-types';
import { Center, Group, Stack } from '@mantine/core';
import { Download, ExternalLink } from 'lucide-react';

const GITHUB_REPO = 'whalesync/scratch-cli';
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

type AssetGroup = { platform: string; assets: DesktopReleaseAsset[] };

function groupAssetsByPlatform(assets: DesktopReleaseAsset[]): AssetGroup[] {
  const downloadable = assets.filter((a) => !/^checksums\.txt$/i.test(a.name));
  const groups: AssetGroup[] = [];
  const take = (platform: string, match: (name: string) => boolean) => {
    const matching = downloadable.filter((a) => match(a.name));
    if (matching.length > 0) groups.push({ platform, assets: matching });
  };

  take('macOS (Apple Silicon)', (n) => /arm64.*\.(zip|dmg)$/i.test(n));
  take('macOS (Intel)', (n) => /x64.*\.(zip|dmg)$/i.test(n));
  take('Linux', (n) => /\.(AppImage|deb)$/i.test(n));
  return groups;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

export default function DownloadPage() {
  const { release, isLoading, error } = useDesktopRelease();
  const { isDevToolsEnabled } = useDevTools();

  if (isLoading) return <FullPageLoader message="Loading latest release…" />;

  return (
    <MainContent h="100vh">
      <MainContent.Body p="xl">
        <Center h="100%" w="100%">
          <Stack gap="lg" maw={720} w="100%" align="center">
            {!release || error ? <UnavailableState /> : <ReleaseDetails release={release} showDevTools={isDevToolsEnabled} />}
          </Stack>
        </Center>
      </MainContent.Body>
    </MainContent>
  );
}

function UnavailableState() {
  return (
    <Stack gap="md">
      <Text16Regular>We couldn&apos;t load the latest release from GitHub.</Text16Regular>
      <ButtonSecondaryOutline
        component="a"
        href={RELEASES_URL}
        rightSection={<StyledLucideIcon Icon={ExternalLink} size="sm" />}
      >
        Browse all releases on GitHub
      </ButtonSecondaryOutline>
    </Stack>
  );
}

function ReleaseDetails({ release, showDevTools }: { release: DesktopReleaseResponse; showDevTools: boolean }) {
  return (
    <Stack gap="lg">
      <Center>
        <TextTitle3>Download Scratch Desktop {release.version}</TextTitle3>
      </Center>

      {groupAssetsByPlatform(release.assets).map((group) => (
        <Stack key={group.platform} gap="xs">
          <Text13Regular>{group.platform}</Text13Regular>
          <Group gap="sm">
            {group.assets.map((asset) => (
              <ButtonPrimarySolid
                key={asset.name}
                component="a"
                href={asset.url}
                leftSection={<StyledLucideIcon Icon={Download} size="sm" />}
              >
                {asset.name} ({formatBytes(asset.size)})
              </ButtonPrimarySolid>
            ))}
          </Group>
        </Stack>
      ))}

      {showDevTools && (
        <DevToolButtonGhost component="a" href={release.htmlUrl} size="xs">
          View release on GitHub
        </DevToolButtonGhost>
      )}
    </Stack>
  );
}
