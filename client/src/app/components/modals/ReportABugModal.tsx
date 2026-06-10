'use client';

import { useActiveWorkbook } from '@/hooks/use-active-workbook';
import { useScratchPadUser } from '@/hooks/useScratchpadUser';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { getSessionId, getSessionReplayUrl } from '@/lib/posthog';
import { useLayoutManagerStore } from '@/stores/layout-manager-store';
import { isExperimentEnabled } from '@/types/server-entities/users';
import { Alert, Anchor, Box, Group, Image, Loader, Stack, Textarea, TextInput } from '@mantine/core';
import { useForm } from '@mantine/form';
import * as htmlToImage from 'html-to-image';
import { CameraIcon, XIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { ButtonPrimaryLight, ButtonSecondaryOutline } from '../base/buttons';
import { Text13Book } from '../base/text';
import { ModalWrapper } from '../ModalWrapper';
import { ScratchpadNotifications } from '../ScratchpadNotifications';

export function ReportABugModal() {
  const { user } = useScratchPadUser();
  const reportABugModalOpened = useLayoutManagerStore((state) => state.reportABugModalOpened);
  const openReportABugModal = useLayoutManagerStore((state) => state.openReportABugModal);
  const closeReportABugModal = useLayoutManagerStore((state) => state.closeReportABugModal);
  const [bugReportScreenshot, setBugReportScreenshot] = useState<string | null>(null);

  const { workbook } = useActiveWorkbook();

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isCapturingScreenshot, setIsCapturingScreenshot] = useState(false);
  const pathname = usePathname();

  const isWorkbookPage = usePathname().startsWith('/workbook') && workbook;

  const form = useForm({
    initialValues: {
      title: '',
      description: '',
    },
    validate: {
      title: (value) => (value.trim().length > 0 ? null : 'Title is required'),
      description: (value) => (value.trim().length > 0 ? null : 'Description is required'),
    },
  });

  const handleTakeScreenshot = async () => {
    try {
      // Close the modal first to remove the backdrop
      closeReportABugModal();

      // Small delay to allow the modal and backdrop to fully hide
      await new Promise((resolve) => setTimeout(resolve, 150));

      setIsCapturingScreenshot(true);

      // Another small delay to show the spinner before capture
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Capture the screenshot with reduced quality
      const dataUrl = await htmlToImage.toJpeg(document.body, {
        cacheBust: true,
        skipFonts: false,
        pixelRatio: 1.0, // If you have to reduce file size.
        quality: 0.7, // JPEG quality (0-1)
      });

      setBugReportScreenshot(dataUrl);
      setIsCapturingScreenshot(false);

      // Reopen the modal after capture
      openReportABugModal();
    } catch (error) {
      console.error('Failed to capture screenshot:', error);
      setError('Failed to capture screenshot. Please try again.');
      setIsCapturingScreenshot(false);
      // Reopen the modal even if capture failed
      openReportABugModal();
    }
  };

  const handleRemoveScreenshot = () => {
    setBugReportScreenshot(null);
  };

  const handleSubmit = async () => {
    if (!form.validate().hasErrors) {
      try {
        setIsSubmitting(true);
        const { link } = await scratchApiClient.bugReport.report({
          title: form.values.title,
          userDescription: form.values.description,
          sessionId: getSessionId(),
          replayUrl: getSessionReplayUrl(),
          pageUrl: pathname,
          // add some additional context based on the page the user is on
          workbookId: isWorkbookPage ? workbook?.id : undefined,
          screenshot: bugReportScreenshot || undefined,
        });
        form.reset();
        setBugReportScreenshot(null);
        closeReportABugModal();

        let notificationMessage: React.ReactNode = 'Thank you for your report! The dev team was notified.';
        if (user?.isAdmin && link) {
          notificationMessage = (
            <Stack>
              <Text13Book>Thank you for your report! The dev team was notified.</Text13Book>
              <Anchor href={link} target="_blank">
                View in Linear
              </Anchor>
            </Stack>
          );
        }
        // Admins need to close the notification themselves, keeps the linear link open for them.
        ScratchpadNotifications.success({ message: notificationMessage, autoClose: user?.isAdmin ? false : undefined });
      } catch (error) {
        console.error('Failed to submit bug report:', error);
        setError(
          error instanceof Error
            ? error.message
            : 'An unexpected error occured while submitting your bug. please try again',
        );
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const handleCancel = () => {
    form.reset();
    setBugReportScreenshot(null);
    closeReportABugModal();
  };

  if (!isExperimentEnabled('ENABLE_CREATE_BUG_REPORT', user)) {
    return null;
  }

  // Show loader when capturing screenshot - only if modal is closed
  if (isCapturingScreenshot && !reportABugModalOpened) {
    return (
      <Box
        pos="fixed"
        top={0}
        left={0}
        w="100vw"
        h="100vh"
        style={{
          background: 'transparent',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 9999,
          pointerEvents: 'none',
        }}
      >
        <Stack
          align="center"
          gap="md"
          style={{
            background: 'rgba(0, 0, 0, 0.8)',
            padding: '24px 32px',
            borderRadius: '8px',
          }}
        >
          <Loader size="xl" color="white" />
          <Text13Book style={{ color: 'white' }}>Capturing screenshot...</Text13Book>
        </Stack>
      </Box>
    );
  }

  return (
    <ModalWrapper
      title="Report a Bug"
      size="xl"
      centered
      opened={reportABugModalOpened}
      onClose={handleCancel}
      customProps={{
        footer: (
          <Group>
            <ButtonSecondaryOutline onClick={handleCancel} disabled={isSubmitting}>
              Cancel
            </ButtonSecondaryOutline>
            <ButtonPrimaryLight onClick={handleSubmit} loading={isSubmitting}>
              Submit
            </ButtonPrimaryLight>
          </Group>
        ),
      }}
    >
      <Stack gap="md">
        {error && (
          <Alert variant="light" color="red" title="Failed to submit bug report">
            {error}
          </Alert>
        )}
        <TextInput
          label="Title"
          required
          placeholder="Enter a brief title for the bug"
          disabled={isSubmitting}
          {...form.getInputProps('title')}
        />
        <Textarea
          label="Description"
          placeholder="Describe the bug in detail"
          minRows={10}
          autosize
          required
          disabled={isSubmitting}
          {...form.getInputProps('description')}
        />

        {/* Screenshot section */}
        <Stack gap="sm">
          {!bugReportScreenshot ? (
            <ButtonSecondaryOutline
              onClick={handleTakeScreenshot}
              disabled={isSubmitting}
              leftSection={<CameraIcon size={16} />}
            >
              Take screenshot
            </ButtonSecondaryOutline>
          ) : (
            <Stack gap="xs">
              <Group justify="space-between">
                <Text13Book>Screenshot attached</Text13Book>
                <ButtonSecondaryOutline onClick={handleRemoveScreenshot} disabled={isSubmitting} size="xs">
                  <XIcon size={14} />
                </ButtonSecondaryOutline>
              </Group>
              <Box
                style={{
                  border: '1px solid var(--mantine-color-gray-4)',
                  borderRadius: '4px',
                  overflow: 'hidden',
                  maxHeight: '200px',
                }}
              >
                <Image src={bugReportScreenshot} alt="Screenshot preview" fit="contain" />
              </Box>
            </Stack>
          )}
        </Stack>
      </Stack>
    </ModalWrapper>
  );
}
