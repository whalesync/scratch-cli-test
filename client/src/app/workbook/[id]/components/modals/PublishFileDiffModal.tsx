'use client';

import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { formatNumber } from '@/utils/helpers';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import { Group, Loader, Modal, SegmentedControl, Stack, Text, Title } from '@mantine/core';
import type { FileDiffStatus, PublishDiffAnchor, PublishPlanFileDiff, WorkbookId } from '@spinner/shared-types';
import { GitCompareIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { MergeEditor } from '../shared/MergeEditor';
import { UnifiedDiffView } from '../shared/UnifiedDiffView';

type DiffLayout = 'inline' | 'sideBySide';

/** Title-cased label for each changed-file status. */
export const FILE_DIFF_STATUS_LABEL: Record<FileDiffStatus, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
};

/** Mantine CSS variable for the text colour of each changed-file status. */
export const FILE_DIFF_STATUS_TEXT_COLOR: Record<FileDiffStatus, string> = {
  added: 'var(--mantine-color-green-6)',
  modified: 'var(--mantine-color-blue-6)',
  deleted: 'var(--mantine-color-red-6)',
};

interface PublishFileDiffModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  publishPlanId: string;
  filePath: string;
  /** The older side of the comparison. Defaults to `pre-main` (main before the publish). */
  from?: PublishDiffAnchor;
  /** The newer side of the comparison. Defaults to `post-main` (main after the publish). */
  to?: PublishDiffAnchor;
}

/**
 * Shows what a publish changed in one record file: the file's content at the `from`
 * anchor versus the `to` anchor of the publish run (by default what was on `main`
 * before the publish versus what landed on `main` after it).
 */
export function PublishFileDiffModal({
  opened,
  onClose,
  workbookId,
  publishPlanId,
  filePath,
  from = 'pre-main',
  to = 'post-main',
}: PublishFileDiffModalProps) {
  const [layout, setLayout] = useState<DiffLayout>('inline');

  const {
    data: fileDiff,
    error,
    isLoading,
  } = useSWR<PublishPlanFileDiff, Error>(
    opened ? SWR_KEYS.publishPlans.fileDiff(workbookId, publishPlanId, filePath, from, to) : null,
    () => scratchApiClient.publish.getPublishPlanFileDiff(workbookId, publishPlanId, filePath, { from, to }),
  );

  const { beforeFormatted, afterFormatted } = useMemo(
    () => ({
      beforeFormatted: formatJsonForDiff(fileDiff?.before ?? null),
      afterFormatted: formatJsonForDiff(fileDiff?.after ?? null),
    }),
    [fileDiff?.before, fileDiff?.after],
  );

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <GitCompareIcon size={18} />
          <Title order={5}>Publish Diff</Title>
          {fileDiff && fileDiff.status !== 'unchanged' && (
            <Text size="xs" fw={600} c={FILE_DIFF_STATUS_TEXT_COLOR[fileDiff.status]}>
              {FILE_DIFF_STATUS_LABEL[fileDiff.status]}
            </Text>
          )}
          <Text size="xs" c="dimmed" ff="monospace">
            {filePath}
          </Text>
        </Group>
      }
      size="90%"
      zIndex={310}
    >
      {isLoading ? (
        <Stack align="center" py="xl">
          <Loader size="md" />
          <Text size="sm" c="dimmed">
            Loading diff...
          </Text>
        </Stack>
      ) : error ? (
        <Text size="sm" c="red" ta="center" py="xl">
          {error instanceof Error ? error.message : 'Failed to load diff'}
        </Text>
      ) : !fileDiff ? null : (
        <Stack gap="sm">
          <Group gap="xs" justify="space-between">
            <Text size="xs" c="dimmed">
              {describeChangedFieldCount(fileDiff)}
            </Text>
            <SegmentedControl
              size="xs"
              value={layout}
              onChange={(value) => setLayout(value as DiffLayout)}
              data={[
                { label: 'Inline', value: 'inline' },
                { label: 'Side by Side', value: 'sideBySide' },
              ]}
            />
          </Group>

          {fileDiff.status === 'unchanged' ? (
            <Text size="sm" c="dimmed" ta="center" py="xl">
              This file is identical at both anchors.
            </Text>
          ) : (
            <div style={{ height: 500 }}>
              {layout === 'inline' ? (
                <UnifiedDiffView original={beforeFormatted} modified={afterFormatted} />
              ) : (
                <MergeEditor
                  original={beforeFormatted}
                  modified={afterFormatted}
                  extensions={[json(), EditorView.editable.of(false)]}
                />
              )}
            </div>
          )}
        </Stack>
      )}
    </Modal>
  );
}

/**
 * "3 changed fields" for a modified record. `changedFields` is `null` for added / deleted
 * files (there is no record on one side to diff against), so those fall back to a
 * description of the whole-file change.
 */
function describeChangedFieldCount(fileDiff: PublishPlanFileDiff): string {
  if (fileDiff.changedFields === null) {
    if (fileDiff.status === 'added') return 'New file';
    if (fileDiff.status === 'deleted') return 'File removed';
    return '';
  }
  const changedFieldCount = countChangedLeafFields(fileDiff.changedFields);
  if (changedFieldCount === 0) return 'Formatting only';
  return `${formatNumber(changedFieldCount)} changed ${changedFieldCount === 1 ? 'field' : 'fields'}`;
}

/**
 * `changedFields` is a sparse deep diff: a changed value sits under its full key path, so
 * a record whose `fields.Amount` and `fields.Tags` changed arrives as
 * `{ fields: { Amount, Tags } }`. Counting top-level keys would report 1 there; this
 * counts the leaf paths instead. Arrays and primitives are leaves. An empty nested
 * object is a leaf too (the value became `{}`), while an empty top-level diff is 0.
 */
function countChangedLeafFields(sparseChangedFields: Record<string, unknown>): number {
  let leafCount = 0;
  for (const changedValue of Object.values(sparseChangedFields)) {
    if (isPlainObject(changedValue) && Object.keys(changedValue).length > 0) {
      leafCount += countChangedLeafFields(changedValue);
    } else {
      leafCount += 1;
    }
  }
  return leafCount;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Pretty-print JSON so the diff highlights field changes rather than whole-line reflows. */
function formatJsonForDiff(raw: string | null): string {
  if (raw === null) return '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
