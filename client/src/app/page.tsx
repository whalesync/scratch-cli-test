'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Medium, Text13Regular, Text16Regular, TextTitle2 } from '@/app/components/base/text';
import { FullPageLoader } from '@/app/components/FullPageLoader';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { useDesktopRelease } from '@/hooks/use-desktop-release';
import { useWorkbooks } from '@/hooks/use-workbooks';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { usersApi } from '@/lib/api/users';
import { workbookApi } from '@/lib/api/workbook';
import { isExperimentEnabled } from '@/types/server-entities/users';
import { RouteUrls } from '@/utils/route-urls';
import { UserButton } from '@clerk/nextjs';
import { Box, Center, Divider, Group, Stack, TextInput, UnstyledButton } from '@mantine/core';
import type { DesktopReleaseAsset, Workbook } from '@spinner/shared-types';
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  MonitorIcon,
  PlusIcon,
  SettingsIcon,
  UserIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

function findMacDmg(assets: DesktopReleaseAsset[] | undefined): DesktopReleaseAsset | null {
  if (!assets) return null;
  const arm64 = assets.find((a) => /arm64.*\.dmg$/i.test(a.name));
  if (arm64) return arm64;
  return assets.find((a) => /\.dmg$/i.test(a.name)) ?? null;
}

function DesktopLandingPage({ displayName, lastWorkbookId }: { displayName: string; lastWorkbookId?: string }) {
  const { release, isLoading: isReleaseLoading } = useDesktopRelease();
  const macDmg = findMacDmg(release?.assets);
  return (
    <Box
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--bg-base)',
        position: 'relative',
      }}
    >
      <Center>
        <Stack align="center" gap="xl" maw={400} px="md">
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
      </Center>

      {/* Bottom-right "Switch to Scratch Web" */}
      {lastWorkbookId && (
        <Box style={{ position: 'fixed', bottom: 0, right: 0 }} p="sm">
          <Link href={RouteUrls.workbookFilesPageUrl(lastWorkbookId)} style={{ textDecoration: 'none' }}>
            <ButtonSecondaryOutline size="xs">Switch to Scratch Web</ButtonSecondaryOutline>
          </Link>
        </Box>
      )}

      {/* Bottom-left user menu */}
      <Stack gap={0} style={{ position: 'fixed', bottom: 0, left: 0, width: 220 }} py="xs">
        <Link href={RouteUrls.settingsPageUrl} style={{ textDecoration: 'none' }}>
          <UnstyledButton px="sm" py={8} style={{ width: '100%' }}>
            <Group gap={8} wrap="nowrap">
              <StyledLucideIcon Icon={SettingsIcon} size="sm" c="var(--fg-secondary)" />
              <Text13Regular c="var(--fg-secondary)">Settings</Text13Regular>
            </Group>
          </UnstyledButton>
        </Link>
        <Box pos="relative">
          <UnstyledButton px="sm" py={8} style={{ width: '100%' }}>
            <Group gap={8} wrap="nowrap" justify="space-between">
              <Group gap={8} wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
                <StyledLucideIcon Icon={UserIcon} size="sm" c="var(--fg-secondary)" />
                <Text13Regular c="var(--fg-secondary)" truncate style={{ flex: 1 }}>
                  {displayName}
                </Text13Regular>
              </Group>
              <ChevronDownIcon size={12} color="var(--fg-secondary)" style={{ flexShrink: 0 }} />
            </Group>
          </UnstyledButton>
          <Box pos="absolute" top={0} left={0} w="100%" h="100%" style={{ zIndex: 10, opacity: 0, overflow: 'hidden' }}>
            <UserButton
              appearance={{
                elements: {
                  rootBox: { width: '100%', height: '100%' },
                  userButtonTrigger: { width: '100%', height: '100%', cursor: 'pointer' },
                },
              }}
            />
          </Box>
        </Box>
      </Stack>
    </Box>
  );
}

/**
 * Home page - shows welcome/picker screen.
 * Auto-redirect to lastWorkbookId is handled by ScratchPadUserProvider,
 * so this page only renders when the user has no lastWorkbookId.
 * When SHOW_DESKTOP_FOCUSED_UI is enabled, shows a desktop download landing page instead.
 */
export default function HomePage() {
  const { user } = useScratchPadUser();
  const router = useRouter();
  const { workbooks, isLoading: isWorkbooksLoading } = useWorkbooks();
  const [projectName, setProjectName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  if (isExperimentEnabled('SHOW_DESKTOP_FOCUSED_UI', user)) {
    const displayName = user?.name || user?.email || 'User';
    return <DesktopLandingPage displayName={displayName} lastWorkbookId={user?.lastWorkbookId} />;
  }

  const hasWorkbooks = workbooks && workbooks.length > 0;

  const handleSelectWorkbook = async (workbook: Workbook) => {
    // Update last workbook and navigate
    usersApi.updateLastWorkbook(workbook.id).catch(console.error);
    router.push(`/workbook/${workbook.id}/files`);
  };

  const handleCreateProject = async () => {
    const name = projectName.trim() || 'My workspace';
    setIsCreating(true);
    try {
      const newWorkbook = await workbookApi.create({ name });
      // lastWorkbookId is set automatically by the server on create
      router.push(`/workbook/${newWorkbook.id}/files`);
    } catch (error) {
      console.error('Failed to create project:', error);
      setIsCreating(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !isCreating) {
      handleCreateProject();
    }
  };

  if (isWorkbooksLoading) {
    return <FullPageLoader />;
  }

  return (
    <Box
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: 'var(--bg-base)',
      }}
    >
      <Center>
        <Stack align="center" gap="xl" maw={400} px="md">
          {/* Logo */}
          <Box
            style={{
              width: 64,
              height: 64,
              backgroundColor: '#9BF9EB',
              borderRadius: 12,
              backgroundImage: 'url(/logo-color.svg)',
              backgroundSize: 72,
              backgroundRepeat: 'no-repeat',
              backgroundPosition: 'center',
            }}
          />

          {/* Welcome text */}
          <Stack align="center" gap="xs">
            <TextTitle2>Welcome to Scratch</TextTitle2>
            <Text13Regular c="dimmed" ta="center">
              {hasWorkbooks
                ? 'Select a workspace to continue, or create a new one.'
                : 'Enter a name for your first workspace to get started.'}
            </Text13Regular>
          </Stack>

          {/* Existing workbooks list — pending-delete workspaces are sorted to the bottom
              so the active ones stay easy to scan. */}
          {hasWorkbooks && !showCreateForm && (
            <Stack gap="xs" w="100%">
              {[...workbooks]
                .sort((a, b) => Number(a.isPendingDelete) - Number(b.isPendingDelete))
                .map((workbook) => {
                  const isPendingDelete = workbook.isPendingDelete;
                return (
                  <UnstyledButton
                    key={workbook.id}
                    onClick={() => {
                      if (!isPendingDelete) handleSelectWorkbook(workbook);
                    }}
                    disabled={isPendingDelete}
                    style={{
                      padding: '12px 16px',
                      borderRadius: 8,
                      border: '1px solid var(--mantine-color-gray-3)',
                      backgroundColor: 'var(--bg-base)',
                      transition: 'all 0.15s ease',
                      cursor: isPendingDelete ? 'not-allowed' : 'pointer',
                      opacity: isPendingDelete ? 0.55 : 1,
                    }}
                    onMouseEnter={(e) => {
                      if (isPendingDelete) return;
                      e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                      e.currentTarget.style.borderColor = 'var(--mantine-color-gray-4)';
                    }}
                    onMouseLeave={(e) => {
                      if (isPendingDelete) return;
                      e.currentTarget.style.backgroundColor = 'var(--bg-base)';
                      e.currentTarget.style.borderColor = 'var(--mantine-color-gray-3)';
                    }}
                  >
                    <Group justify="space-between" wrap="nowrap">
                      <Stack gap={2} style={{ flex: 1, minWidth: 0 }}>
                        <Text13Medium truncate>{workbook.name ?? 'Untitled'}</Text13Medium>
                        {isPendingDelete && (
                          <Text13Regular c="dimmed" truncate>
                            Delete in progress…
                          </Text13Regular>
                        )}
                      </Stack>
                      {!isPendingDelete && <ChevronRightIcon size={16} color="var(--fg-muted)" />}
                    </Group>
                  </UnstyledButton>
                );
              })}

              <Divider my="xs" label="or" labelPosition="center" />

              <ButtonSecondaryOutline
                fullWidth
                leftSection={<PlusIcon size={16} />}
                onClick={() => setShowCreateForm(true)}
              >
                Create new workspace
              </ButtonSecondaryOutline>
            </Stack>
          )}

          {/* Create form - shown when no workbooks OR user clicked "Create new" */}
          {(!hasWorkbooks || showCreateForm) && (
            <Stack gap="sm" w="100%">
              <TextInput
                placeholder="My workspace"
                value={projectName}
                onChange={(e) => setProjectName(e.currentTarget.value)}
                onKeyDown={handleKeyDown}
                size="md"
                disabled={isCreating}
                data-autofocus
                styles={{
                  input: {
                    textAlign: 'center',
                  },
                }}
              />
              <ButtonPrimaryLight fullWidth onClick={handleCreateProject} loading={isCreating}>
                Create workspace
              </ButtonPrimaryLight>
              {hasWorkbooks && showCreateForm && (
                <ButtonSecondaryOutline fullWidth onClick={() => setShowCreateForm(false)}>
                  Back to workspace list
                </ButtonSecondaryOutline>
              )}
            </Stack>
          )}
        </Stack>
      </Center>
    </Box>
  );
}
