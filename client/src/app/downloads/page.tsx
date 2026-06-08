'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import {
  Text12Regular,
  Text13Medium,
  Text13Regular,
  Text16Regular,
  TextTitle2,
  TextTitle4,
} from '@/app/components/base/text';
import { FullPageLoader } from '@/app/components/FullPageLoader';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import MainContent from '@/app/components/layouts/MainContent';
import { useCliRelease } from '@/hooks/use-cli-release';
import { useDesktopRelease } from '@/hooks/use-desktop-release';
import { DownloadPlatform, trackDownloadCli, trackDownloadDesktopApp } from '@/lib/posthog';
import { Anchor, Box, Card, Collapse, Divider, Group, Image, Stack, UnstyledButton } from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import { DesktopReleaseAsset, DesktopReleaseResponse } from '@spinner/shared-types';
import { Calendar, ChevronRight, Download, ExternalLink, Mail, TerminalSquare } from 'lucide-react';

const RELEASES_URL = 'https://github.com/whalesync/scratch-desktop/releases';
const CALENDLY_URL = 'https://calendly.com/d/cx4x-772-kpg/welcome-to-scratch';

const OS_ICON_BASE_URL = 'https://static.scratch.md/os-icons';

const PLATFORM_ICONS = {
  MacOS: `${OS_ICON_BASE_URL}/Apple.svg`,
  Windows: `${OS_ICON_BASE_URL}/Windows-11.svg`,
  Linux: `${OS_ICON_BASE_URL}/Linux.svg`,
} as const;

type AssetVariant = { label: string; asset: DesktopReleaseAsset };
type PlatformGroup = { platform: DownloadPlatform; iconUrl: string; variants: AssetVariant[] };

function desktopVariantLabel(filename: string): string {
  if (/arm64.*\.dmg$/i.test(filename)) return 'Apple Silicon (.dmg)';
  if (/x64.*\.dmg$/i.test(filename)) return 'Intel (.dmg)';
  if (/\.exe$/i.test(filename)) return 'x64 (.exe)';
  if (/\.AppImage$/i.test(filename)) return 'AppImage';
  if (/\.deb$/i.test(filename)) return 'Debian (.deb)';
  return filename;
}

function cliVariantLabel(filename: string): string {
  if (/darwin_arm64/i.test(filename)) return 'Apple Silicon (.tar.gz)';
  if (/darwin_amd64/i.test(filename)) return 'Intel (.tar.gz)';
  if (/linux_arm64/i.test(filename)) return 'ARM64 (.tar.gz)';
  if (/linux_amd64/i.test(filename)) return 'x64 (.tar.gz)';
  if (/windows_amd64/i.test(filename)) return 'x64 (.zip)';
  return filename;
}

function groupDesktopAssetsByPlatform(assets: DesktopReleaseAsset[]): PlatformGroup[] {
  const downloadable = assets.filter((a) => !/^checksums\.txt$/i.test(a.name));
  const variantsFor = (match: (n: string) => boolean): AssetVariant[] =>
    downloadable.filter((a) => match(a.name)).map((asset) => ({ label: desktopVariantLabel(asset.name), asset }));

  const groups: PlatformGroup[] = [];
  const mac = variantsFor((n) => /\.dmg$/i.test(n));
  if (mac.length) groups.push({ platform: 'MacOS', iconUrl: PLATFORM_ICONS.MacOS, variants: mac });
  const windows = variantsFor((n) => /\.exe$/i.test(n));
  if (windows.length) groups.push({ platform: 'Windows', iconUrl: PLATFORM_ICONS.Windows, variants: windows });
  const linux = variantsFor((n) => /\.(AppImage|deb)$/i.test(n));
  if (linux.length) groups.push({ platform: 'Linux', iconUrl: PLATFORM_ICONS.Linux, variants: linux });
  return groups;
}

function groupCliAssetsByPlatform(assets: DesktopReleaseAsset[]): PlatformGroup[] {
  const variantsFor = (match: (n: string) => boolean): AssetVariant[] =>
    assets.filter((a) => match(a.name)).map((asset) => ({ label: cliVariantLabel(asset.name), asset }));

  const groups: PlatformGroup[] = [];
  const mac = variantsFor((n) => /scratchmd_darwin_/i.test(n));
  if (mac.length) groups.push({ platform: 'MacOS', iconUrl: PLATFORM_ICONS.MacOS, variants: mac });
  const windows = variantsFor((n) => /scratchmd_windows_/i.test(n));
  if (windows.length) groups.push({ platform: 'Windows', iconUrl: PLATFORM_ICONS.Windows, variants: windows });
  const linux = variantsFor((n) => /scratchmd_linux_/i.test(n));
  if (linux.length) groups.push({ platform: 'Linux', iconUrl: PLATFORM_ICONS.Linux, variants: linux });
  return groups;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

export default function DownloadPage() {
  const { release: desktopRelease, isLoading: desktopLoading, error: desktopError } = useDesktopRelease();
  const { release: cliRelease, error: cliError } = useCliRelease();

  if (desktopLoading) return <FullPageLoader message="Loading latest release…" />;

  if (!desktopRelease || desktopError) {
    return (
      <MainContent h="100vh">
        <MainContent.Body p="xl">
          <Stack gap="md" maw={480} mx="auto" mt={80}>
            <Text16Regular>We couldn&apos;t load the latest release from GitHub.</Text16Regular>
            <ButtonSecondaryOutline
              component="a"
              href={RELEASES_URL}
              rightSection={<StyledLucideIcon Icon={ExternalLink} size="sm" />}
            >
              Browse all releases on GitHub
            </ButtonSecondaryOutline>
          </Stack>
        </MainContent.Body>
      </MainContent>
    );
  }

  return (
    <MainContent h="100vh">
      <MainContent.Body p="xl">
        <Box maw={960} mx="auto" py="xl">
          <Group align="flex-start" gap={48} wrap="nowrap" style={{ minHeight: 0 }}>
            {/* Left: Download section */}
            <Box style={{ flex: 1, minWidth: 0 }}>
              <DesktopSection release={desktopRelease} />
              {cliRelease && !cliError && <CliDisclosure release={cliRelease} />}
            </Box>

            {/* Right: Getting started sidebar */}
            <Box w={300} style={{ flexShrink: 0 }}>
              <GettingStartedCard />
            </Box>
          </Group>
        </Box>
      </MainContent.Body>
    </MainContent>
  );
}

function DesktopSection({ release }: { release: DesktopReleaseResponse }) {
  const groups = groupDesktopAssetsByPlatform(release.assets);
  return (
    <Stack gap="lg">
      {/* Header: icon + version */}
      <Group gap="lg" align="center">
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
            boxShadow: '0 4px 16px rgba(11,107,79,.12)',
            flexShrink: 0,
          }}
        />
        <Stack gap={4}>
          <TextTitle2>Scratch Desktop</TextTitle2>
          <Group gap="sm">
            <Text12Regular c="dimmed">{release.version}</Text12Regular>
            <Text12Regular c="dimmed">·</Text12Regular>
            <Anchor href="https://www.scratch.md/changelog/" size="xs" c="dimmed">
              View changelog
            </Anchor>
            <Text12Regular c="dimmed">·</Text12Regular>
            <Anchor href={release.htmlUrl} size="xs" c="dimmed">
              View on GitHub
            </Anchor>
          </Group>
        </Stack>
      </Group>

      <Divider />

      {/* Platform download groups — indented to align with title text */}
      <Stack gap="xl" pl={96}>
        {groups.map((group) => (
          <PlatformDownloadRow
            key={group.platform}
            group={group}
            onDownloadVariantClicked={(variant) =>
              trackDownloadDesktopApp({
                section: 'downloads_page',
                platform: group.platform,
                variant: variant.label,
                assetName: variant.asset.name,
                version: release.version,
              })
            }
          />
        ))}
      </Stack>
    </Stack>
  );
}

function PlatformDownloadRow({
  group,
  onDownloadVariantClicked,
}: {
  group: PlatformGroup;
  onDownloadVariantClicked: (variant: AssetVariant) => void;
}) {
  return (
    <Stack gap="xs">
      <Group gap="sm" align="center">
        <Image src={group.iconUrl} alt={`${group.platform} icon`} w={20} h={20} />
        <Text13Medium>{group.platform}</Text13Medium>
      </Group>
      <Stack gap={6} pl={28}>
        {group.variants.map((variant) => (
          <Anchor
            key={variant.asset.name}
            href={variant.asset.url}
            size="sm"
            c="var(--mantine-color-green-7)"
            underline="hover"
            onClick={() => onDownloadVariantClicked(variant)}
          >
            <Group gap={6} align="center">
              <StyledLucideIcon Icon={Download} size="sm" c="var(--mantine-color-green-7)" />
              {variant.label}
              <Text12Regular c="dimmed" component="span">
                ({formatBytes(variant.asset.size)})
              </Text12Regular>
            </Group>
          </Anchor>
        ))}
      </Stack>
    </Stack>
  );
}

function CliDisclosure({ release }: { release: DesktopReleaseResponse }) {
  const [opened, { toggle }] = useDisclosure(false);
  const groups = groupCliAssetsByPlatform(release.assets);
  if (!groups.length) return null;

  return (
    <Box mt="xl">
      <Divider mb="lg" />
      <UnstyledButton onClick={toggle}>
        <Group gap={4} align="center">
          <Box style={{ transform: opened ? 'rotate(90deg)' : undefined, transition: 'transform 150ms' }}>
            <StyledLucideIcon Icon={ChevronRight} size="sm" c="dimmed" />
          </Box>
          <Text13Regular c="dimmed">Advanced: Download only Scratch CLI</Text13Regular>
        </Group>
      </UnstyledButton>
      <Collapse in={opened}>
        <Stack gap="lg" mt="lg">
          {/* CLI header: icon + title, mirroring desktop section */}
          <Group gap="lg" align="center">
            <Box
              style={{
                width: 80,
                height: 80,
                backgroundColor: 'var(--mantine-color-gray-1)',
                borderRadius: 16,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <TerminalSquare size={40} color="var(--fg-secondary)" strokeWidth={1.5} />
            </Box>
            <Stack gap={4}>
              <TextTitle2>Scratch CLI</TextTitle2>
              <Text12Regular c="dimmed">
                Scratch Desktop includes the CLI. This standalone install is for advanced users only.
              </Text12Regular>
              <Anchor href={release.htmlUrl} size="xs" c="dimmed">
                View on GitHub
              </Anchor>
            </Stack>
          </Group>

          <Divider />

          <Stack gap="xl" pl={96}>
            {groups.map((group) => (
              <PlatformDownloadRow
                key={group.platform}
                group={group}
                onDownloadVariantClicked={(variant) =>
                  trackDownloadCli({
                    platform: group.platform,
                    variant: variant.label,
                    assetName: variant.asset.name,
                    version: release.version,
                  })
                }
              />
            ))}
          </Stack>
        </Stack>
      </Collapse>
    </Box>
  );
}

function GettingStartedCard() {
  return (
    <Card
      withBorder
      padding="lg"
      radius="md"
      style={{
        backgroundColor: 'var(--bg-panel)',
      }}
    >
      <Stack gap="md">
        <TextTitle4>Get started with Scratch</TextTitle4>
        <Text13Regular c="dimmed">
          Scratch is in early beta and we&apos;re building fast. Here are a few things to help you hit the ground
          running.
        </Text13Regular>

        <Divider />

        <Stack gap="sm">
          <Group gap="sm" align="flex-start" wrap="nowrap">
            <Box mt={2} style={{ flexShrink: 0 }}>
              <StyledLucideIcon Icon={Calendar} size="md" c="var(--mantine-color-green-7)" />
            </Box>
            <Stack gap={2}>
              <Text13Medium>Book a tour</Text13Medium>
              <Text12Regular c="dimmed">
                Totally optional, but we&apos;d love to hear how you&apos;re planning to use Scratch and point you in
                the right direction.
              </Text12Regular>
            </Stack>
          </Group>
          <Box pl={28}>
            <ButtonPrimaryLight component="a" href={CALENDLY_URL} target="_blank" size="xs" fullWidth>
              Schedule a call
            </ButtonPrimaryLight>
          </Box>
        </Stack>

        <Divider />

        <Stack gap="sm">
          <Group gap="sm" align="flex-start" wrap="nowrap">
            <Box mt={2} style={{ flexShrink: 0 }}>
              <StyledLucideIcon Icon={Mail} size="md" c="var(--mantine-color-green-7)" />
            </Box>
            <Stack gap={2}>
              <Text13Medium>Tell us what you think</Text13Medium>
              <Text12Regular c="dimmed">
                What&apos;s working? What isn&apos;t? Email us anytime — we read every message.
              </Text12Regular>
            </Stack>
          </Group>
          <Box pl={28}>
            <Stack gap={4}>
              <Anchor href="mailto:curtis@whalesync.com" size="xs">
                curtis@whalesync.com
              </Anchor>
              <Anchor href="mailto:ryder@whalesync.com" size="xs">
                ryder@whalesync.com
              </Anchor>
            </Stack>
          </Box>
        </Stack>
      </Stack>
    </Card>
  );
}
