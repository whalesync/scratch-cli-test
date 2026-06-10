import { scratchApiClient } from '@/lib/scratch-api-client';
import { Center, Loader, Modal, ScrollArea, Stack, Tooltip } from '@mantine/core';
import { Bug } from 'lucide-react';
import { useState } from 'react';
import { IconButtonGhost } from '../../components/base/buttons';
import { Text13Regular, TextMono12Regular } from '../../components/base/text';
import { StyledLucideIcon } from '../../components/icons/StyledLucideIcon';

interface JobRawJsonButtonProps {
  jobId?: string | null;
}

export function JobRawJsonButton({ jobId }: JobRawJsonButtonProps) {
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [jobData, setJobData] = useState<unknown>(null);

  const handleOpen = async () => {
    if (!jobId) {
      return;
    }

    setOpened(true);
    setLoading(true);
    setError(null);
    setJobData(null);

    try {
      const rawJob = await scratchApiClient.job.getJobRaw(jobId);
      setJobData(rawJob);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load raw job JSON');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Tooltip label="View raw job JSON">
        <IconButtonGhost
          size="compact-xs"
          aria-label="View raw job JSON"
          disabled={!jobId}
          onClick={() => void handleOpen()}
        >
          <StyledLucideIcon Icon={Bug} size={12} />
        </IconButtonGhost>
      </Tooltip>

      <Modal opened={opened} onClose={() => setOpened(false)} title={`Job JSON — ${jobId ?? 'unknown job'}`} size="xl">
        <Stack gap="sm">
          {loading && (
            <Center py="xl">
              <Loader size="sm" />
            </Center>
          )}

          {!loading && error && <Text13Regular c="var(--mantine-color-red-6)">{error}</Text13Regular>}

          {!loading && !error && (
            <ScrollArea.Autosize mah={520}>
              <TextMono12Regular component="pre" style={{ margin: 0, whiteSpace: 'pre', wordBreak: 'normal' }}>
                {JSON.stringify(jobData, null, 2)}
              </TextMono12Regular>
            </ScrollArea.Autosize>
          )}
        </Stack>
      </Modal>
    </>
  );
}
