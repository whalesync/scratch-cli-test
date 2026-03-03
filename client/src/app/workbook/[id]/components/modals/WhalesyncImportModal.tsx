'use client';

import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { ButtonPrimarySolid, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text12Medium, Text12Regular, Text13Medium, Text13Regular } from '@/app/components/base/text';
import { syncApi } from '@/lib/api/sync';
import { trackWhalesyncImport } from '@/lib/posthog';
import { useSyncStore } from '@/stores/sync-store';
import { Alert, Box, Group, PasswordInput, Stack, TextInput } from '@mantine/core';
import type {
  Caveat,
  CaveatSeverity,
  UnmatchedFolder,
  WhalesyncImportPreviewResponse,
  WorkbookId,
} from '@spinner/shared-types';
import { AlertTriangleIcon, CheckIcon, ClipboardCopyIcon, InfoIcon, XCircleIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

type Step = 'credentials' | 'preview' | 'saving';

interface WhalesyncImportModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
}

function extractCoreBaseId(input: string): string {
  const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  const match = input.match(uuidRegex);
  return match ? match[0] : input.trim();
}

function severityOrder(severity: CaveatSeverity): number {
  switch (severity) {
    case 'error':
      return 0;
    case 'warning':
      return 1;
    case 'info':
      return 2;
  }
}

function SeverityIcon({ severity }: { severity: CaveatSeverity }) {
  switch (severity) {
    case 'error':
      return <StyledLucideIcon Icon={XCircleIcon} size="sm" c="var(--mantine-color-red-6)" />;
    case 'warning':
      return <StyledLucideIcon Icon={AlertTriangleIcon} size="sm" c="var(--mantine-color-yellow-6)" />;
    case 'info':
      return <StyledLucideIcon Icon={InfoIcon} size="sm" c="var(--mantine-color-blue-6)" />;
  }
}

function formatCaveatsForClipboard(caveats: Caveat[], unmatchedFolders: UnmatchedFolder[]): string {
  const lines: string[] = [];

  if (caveats.length > 0) {
    lines.push('=== Caveats ===');
    for (const caveat of caveats) {
      const prefix = caveat.severity === 'error' ? '[ERROR]' : caveat.severity === 'warning' ? '[WARN]' : '[INFO]';
      lines.push(`${prefix} ${caveat.message}`);
      if (caveat.context) {
        lines.push(`  Context: ${caveat.context}`);
      }
    }
  }

  if (unmatchedFolders.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('=== Unmatched Folders ===');
    for (const folder of unmatchedFolders) {
      lines.push(`- ${folder.whalesyncTableName} (${folder.connectorType}, ${folder.side} side)`);
      lines.push(`  ${folder.message}`);
    }
  }

  return lines.join('\n');
}

export function WhalesyncImportModal({ opened, onClose, workbookId }: WhalesyncImportModalProps) {
  const [step, setStep] = useState<Step>('credentials');
  const [apiToken, setApiToken] = useState('');
  const [syncUrlOrId, setSyncUrlOrId] = useState('');
  const [preview, setPreview] = useState<WhalesyncImportPreviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savingProgress, setSavingProgress] = useState(0);
  const [copied, setCopied] = useState(false);

  const fetchSyncs = useSyncStore((state) => state.fetchSyncs);
  const router = useRouter();

  // Reset state when modal opens
  useEffect(() => {
    if (opened) {
      setStep('credentials');
      setApiToken('');
      setSyncUrlOrId('');
      setPreview(null);
      setLoading(false);
      setError(null);
      setSavingProgress(0);
      setCopied(false);
    }
  }, [opened]);

  const handlePreview = async () => {
    const coreBaseId = extractCoreBaseId(syncUrlOrId);
    if (!apiToken.trim()) {
      setError('API token is required.');
      return;
    }
    if (!coreBaseId) {
      setError('Sync URL or ID is required.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await syncApi.importPreview(workbookId, {
        whalesyncApiToken: apiToken.trim(),
        coreBaseId,
      });
      setPreview(result);
      setStep('preview');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to preview import. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    if (!preview) return;

    setStep('saving');
    setError(null);
    setSavingProgress(0);

    try {
      for (let i = 0; i < preview.syncs.length; i++) {
        setSavingProgress(i + 1);
        await syncApi.create(workbookId, preview.syncs[i]);
      }
      await fetchSyncs(workbookId);
      trackWhalesyncImport(workbookId, preview.syncs.length);
      ScratchpadNotifications.success({
        message: `Successfully imported ${preview.syncs.length} sync${preview.syncs.length === 1 ? '' : 's'} from Whalesync.`,
      });
      onClose();
      router.push(`/workbook/${workbookId}/syncs`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save syncs. Please try again.');
      setStep('preview');
    }
  };

  const handleCopyCaveats = async () => {
    if (!preview) return;
    const text = formatCaveatsForClipboard(preview.caveats, preview.unmatchedFolders);
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const sortedCaveats = preview?.caveats.slice().sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));

  const title =
    step === 'credentials' ? 'Import from Whalesync' : step === 'preview' ? 'Import Preview' : 'Saving Syncs';

  const footer = (() => {
    switch (step) {
      case 'credentials':
        return (
          <>
            <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
            <ButtonPrimarySolid onClick={handlePreview} loading={loading}>
              Preview Import
            </ButtonPrimarySolid>
          </>
        );
      case 'preview':
        return (
          <>
            <ButtonSecondaryOutline onClick={() => setStep('credentials')}>Back</ButtonSecondaryOutline>
            <ButtonPrimarySolid onClick={handleSave} disabled={!preview || preview.syncs.length === 0}>
              Save Sync{preview && preview.syncs.length !== 1 ? 's' : ''}
            </ButtonPrimarySolid>
          </>
        );
      case 'saving':
        return null;
    }
  })();

  return (
    <ModalWrapper opened={opened} onClose={onClose} title={title} customProps={{ footer }}>
      {error && (
        <Alert color="red" mb="sm">
          {error}
        </Alert>
      )}

      {step === 'credentials' && (
        <Stack gap="md">
          <Text13Regular c="var(--fg-secondary)">
            Enter your Whalesync API token and the URL or ID of the sync you want to import.
          </Text13Regular>
          <PasswordInput
            label="Whalesync API Token"
            placeholder="Enter your Whalesync API token"
            value={apiToken}
            onChange={(e) => setApiToken(e.currentTarget.value)}
          />
          <TextInput
            label="Sync URL or ID"
            placeholder="https://app.whalesync.com/syncs/... or a UUID"
            value={syncUrlOrId}
            onChange={(e) => setSyncUrlOrId(e.currentTarget.value)}
          />
        </Stack>
      )}

      {step === 'preview' && preview && (
        <Stack gap="md">
          {/* Sync summary */}
          <Box>
            <Text13Medium mb="xs">
              {preview.syncs.length} sync{preview.syncs.length !== 1 ? 's' : ''} to import
            </Text13Medium>
            {preview.syncs.map((sync, i) => (
              <Box key={i} p="xs" mb="xs" style={{ border: '1px solid var(--fg-divider)', borderRadius: 4 }}>
                <Text13Medium>{sync.displayName}</Text13Medium>
                <Text12Regular c="var(--fg-secondary)">
                  {sync.mappings.tableMappings.length} table mapping
                  {sync.mappings.tableMappings.length !== 1 ? 's' : ''}
                </Text12Regular>
              </Box>
            ))}
          </Box>

          {/* Unmatched folders */}
          {preview.unmatchedFolders.length > 0 && (
            <Alert color="orange" title="Prerequisite: Unmatched Folders">
              <Stack gap="xs">
                <Text12Regular>
                  The following tables could not be matched to existing folders. You may need to create connections and
                  pull data before importing.
                </Text12Regular>
                {preview.unmatchedFolders.map((folder, i) => (
                  <Box key={i}>
                    <Text12Medium>
                      {folder.whalesyncTableName} ({folder.connectorType}, {folder.side} side)
                    </Text12Medium>
                    <Text12Regular c="var(--fg-secondary)">{folder.message}</Text12Regular>
                  </Box>
                ))}
              </Stack>
            </Alert>
          )}

          {/* Caveats */}
          {sortedCaveats && sortedCaveats.length > 0 && (
            <Box>
              <Group justify="space-between" mb="xs">
                <Text13Medium>Caveats</Text13Medium>
                <ButtonSecondaryOutline size="compact-xs" onClick={handleCopyCaveats}>
                  <Group gap={4}>
                    <StyledLucideIcon Icon={copied ? CheckIcon : ClipboardCopyIcon} size="sm" />
                    <Text12Regular>{copied ? 'Copied' : 'Copy caveats'}</Text12Regular>
                  </Group>
                </ButtonSecondaryOutline>
              </Group>
              <Stack gap="xs">
                {sortedCaveats.map((caveat, i) => (
                  <Group key={i} gap="xs" wrap="nowrap" align="flex-start">
                    <Box mt={2}>
                      <SeverityIcon severity={caveat.severity} />
                    </Box>
                    <Box>
                      <Text12Regular>{caveat.message}</Text12Regular>
                      {caveat.context && <Text12Regular c="var(--fg-muted)">{caveat.context}</Text12Regular>}
                    </Box>
                  </Group>
                ))}
              </Stack>
            </Box>
          )}

          {preview.syncs.length === 0 && preview.caveats.length === 0 && preview.unmatchedFolders.length === 0 && (
            <Text13Regular c="var(--fg-secondary)">No syncs were found for the given input.</Text13Regular>
          )}
        </Stack>
      )}

      {step === 'saving' && (
        <Stack gap="md" align="center" py="xl">
          <Text13Regular>
            Saving sync {savingProgress} of {preview?.syncs.length ?? 0}...
          </Text13Regular>
        </Stack>
      )}
    </ModalWrapper>
  );
}
