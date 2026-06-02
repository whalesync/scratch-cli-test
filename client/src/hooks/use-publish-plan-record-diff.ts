import { workbookApi } from '@/lib/api/workbook';
import { WorkbookId } from '@spinner/shared-types';
import useSWR from 'swr';

/**
 * Two modes for the record diff on a publish plan:
 *   - `old-vs-edits` (default): main before publish → dirty before publish.
 *     "What was about to be published when the plan ran." Mirrors the
 *     Review & Publish view.
 *   - `old-vs-new`: main before publish → main after publish. "What this
 *     publish actually changed in the canonical state."
 *
 * Either side can be null when the file didn't exist on that ref (newly
 * created records have no `main_pre` content; deletes have no later-side
 * content).
 */
export type PlanRecordDiffMode = 'old-vs-edits' | 'old-vs-new';

export function usePublishPlanRecordDiff(
  workbookId: WorkbookId | undefined,
  planId: string | undefined,
  connectorAccountId: string | null | undefined,
  filePath: string | undefined,
  enabled: boolean,
  mode: PlanRecordDiffMode = 'old-vs-edits',
) {
  const canFetch = !!workbookId && !!planId && !!connectorAccountId && !!filePath && enabled;
  const { data, error, isLoading } = useSWR<{ original: string | null; modified: string | null }, Error>(
    canFetch ? ['publish-plan-record-diff', workbookId, planId, connectorAccountId, filePath, mode] : null,
    async () => {
      if (!workbookId || !planId || !filePath || !connectorAccountId) {
        throw new Error('workbookId, planId, filePath, and connectorAccountId are required');
      }
      const originalRef = `main_pre_plan_${planId}`;
      const modifiedRef = mode === 'old-vs-new' ? `main_plan_${planId}` : `dirty_plan_${planId}`;
      const [originalRes, modifiedRes] = await Promise.allSettled([
        workbookApi.getRepoFile(workbookId, filePath, originalRef, connectorAccountId),
        workbookApi.getRepoFile(workbookId, filePath, modifiedRef, connectorAccountId),
      ]);
      return {
        original: originalRes.status === 'fulfilled' ? (originalRes.value?.content ?? null) : null,
        modified: modifiedRes.status === 'fulfilled' ? (modifiedRes.value?.content ?? null) : null,
      };
    },
  );

  return {
    original: data?.original ?? null,
    modified: data?.modified ?? null,
    error,
    isLoading,
  };
}
