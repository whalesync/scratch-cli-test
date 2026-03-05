'use client';

import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text13Medium, Text13Regular, TextTitle2 } from '@/app/components/base/text';
import { FullPageLoader } from '@/app/components/FullPageLoader';
import { useWorkbooks } from '@/hooks/use-workbooks';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { usersApi } from '@/lib/api/users';
import { workbookApi } from '@/lib/api/workbook';
import { Box, Center, Divider, Group, Stack, TextInput, UnstyledButton } from '@mantine/core';
import type { Workbook } from '@spinner/shared-types';
import { ChevronRightIcon, PlusIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

/**
 * Home page - redirects to a workbook or shows welcome/picker screen
 */
export default function HomePage() {
  const router = useRouter();
  const { user, isLoading: isUserLoading } = useScratchPadUser();
  const { workbooks, isLoading: isWorkbooksLoading } = useWorkbooks();
  const [projectName, setProjectName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [showCreateForm, setShowCreateForm] = useState(false);

  const isLoading = isUserLoading || isWorkbooksLoading;
  const hasWorkbooks = workbooks && workbooks.length > 0;

  // Redirect if user has a last workbook (in useEffect to avoid setState during render)
  const shouldRedirect = !isUserLoading && !!user?.lastWorkbookId;
  useEffect(() => {
    if (shouldRedirect && user?.lastWorkbookId) {
      router.replace(`/workbook/${user.lastWorkbookId}/files`);
    }
  }, [shouldRedirect, user?.lastWorkbookId, router]);

  // Show loader while redirecting
  if (shouldRedirect) {
    return <FullPageLoader message="Loading your workspace..." />;
  }

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

  // Show loading only on initial fetch
  if (isLoading && user === null) {
    return <FullPageLoader message="Loading..." />;
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

          {/* Existing workbooks list */}
          {hasWorkbooks && !showCreateForm && (
            <Stack gap="xs" w="100%">
              {workbooks.map((workbook) => (
                <UnstyledButton
                  key={workbook.id}
                  onClick={() => handleSelectWorkbook(workbook)}
                  style={{
                    padding: '12px 16px',
                    borderRadius: 8,
                    border: '1px solid var(--mantine-color-gray-3)',
                    backgroundColor: 'var(--bg-base)',
                    transition: 'all 0.15s ease',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--bg-hover)';
                    e.currentTarget.style.borderColor = 'var(--mantine-color-gray-4)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.backgroundColor = 'var(--bg-base)';
                    e.currentTarget.style.borderColor = 'var(--mantine-color-gray-3)';
                  }}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <Text13Medium truncate>{workbook.name ?? 'Untitled'}</Text13Medium>
                    <ChevronRightIcon size={16} color="var(--fg-muted)" />
                  </Group>
                </UnstyledButton>
              ))}

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
