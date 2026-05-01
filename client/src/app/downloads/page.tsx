'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline, DevToolButtonGhost } from '@/app/components/base/buttons';
import { Text16Regular, TextTitle3, TextTitle4 } from '@/app/components/base/text';
import { FullPageLoader } from '@/app/components/FullPageLoader';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import MainContent from '@/app/components/layouts/MainContent';
import { useDesktopRelease } from '@/hooks/use-desktop-release';
import { useDevTools } from '@/hooks/use-dev-tools';
import { Box, Card, Center, Group, Image, Stack } from '@mantine/core';
import { DesktopReleaseAsset, DesktopReleaseResponse } from '@spinner/shared-types';
import { Download, ExternalLink } from 'lucide-react';

const GITHUB_REPO = 'whalesync/scratch-cli';
const RELEASES_URL = `https://github.com/${GITHUB_REPO}/releases`;

const OS_ICON_BASE_URL = 'https://static.scratch.md/os-icons';

type AssetVariant = { label: string; asset: DesktopReleaseAsset };
type PlatformGroup = { platform: string; iconUrl: string; variants: AssetVariant[] };

function variantLabel(filename: string): string {
  if (/arm64.*\.dmg$/i.test(filename)) return 'Apple Silicon (.dmg)';
  if (/x64.*\.dmg$/i.test(filename)) return 'Intel (.dmg)';
  if (/\.exe$/i.test(filename)) return 'x64 (.exe)';
  if (/\.AppImage$/i.test(filename)) return 'AppImage';
  if (/\.deb$/i.test(filename)) return 'Debian (.deb)';
  return filename;
}

function groupAssetsByPlatform(assets: DesktopReleaseAsset[]): PlatformGroup[] {
  const downloadable = assets.filter((a) => !/^checksums\.txt$/i.test(a.name));
  const variantsFor = (match: (n: string) => boolean): AssetVariant[] =>
    downloadable.filter((a) => match(a.name)).map((asset) => ({ label: variantLabel(asset.name), asset }));

  const groups: PlatformGroup[] = [];
  const mac = variantsFor((n) => /\.dmg$/i.test(n));
  if (mac.length) groups.push({ platform: 'MacOS', iconUrl: `${OS_ICON_BASE_URL}/Apple.svg`, variants: mac });
  const windows = variantsFor((n) => /\.exe$/i.test(n));
  if (windows.length)
    groups.push({ platform: 'Windows', iconUrl: `${OS_ICON_BASE_URL}/Windows-11.svg`, variants: windows });
  const linux = variantsFor((n) => /\.(AppImage|deb)$/i.test(n));
  if (linux.length) groups.push({ platform: 'Linux', iconUrl: `${OS_ICON_BASE_URL}/Linux.svg`, variants: linux });
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
          <Stack gap="lg" maw={960} w="100%" align="center">
            {!release || error ? (
              <UnavailableState />
            ) : (
              <ReleaseDetails release={release} showDevTools={isDevToolsEnabled} />
            )}
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
  const groups = groupAssetsByPlatform(release.assets);
  return (
    <Stack gap="lg" w="100%" align="center">
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
      <TextTitle3>Download Scratch Desktop {release.version}</TextTitle3>

      <Group gap="md" align="stretch" justify="center" w="100%">
        {groups.map((group) => (
          <PlatformCard key={group.platform} group={group} />
        ))}
      </Group>

      {showDevTools && (
        <DevToolButtonGhost component="a" href={release.htmlUrl} size="xs">
          View release on GitHub
        </DevToolButtonGhost>
      )}
    </Stack>
  );
}

function PlatformCard({ group }: { group: PlatformGroup }) {
  return (
    <Card withBorder flex={1} miw={240} maw={300}>
      <Stack gap="sm">
        <Group gap="sm" align="center">
          <Image src={group.iconUrl} alt={`${group.platform} icon`} w={32} h={32} />
          <TextTitle4>{group.platform}</TextTitle4>
        </Group>
        <Stack gap="xs">
          {group.variants.map(({ label, asset }) => (
            <ButtonPrimaryLight
              key={asset.name}
              component="a"
              href={asset.url}
              fullWidth
              leftSection={<StyledLucideIcon Icon={Download} size="sm" />}
            >
              {label} ({formatBytes(asset.size)})
            </ButtonPrimaryLight>
          ))}
        </Stack>
      </Stack>
    </Card>
  );
}
