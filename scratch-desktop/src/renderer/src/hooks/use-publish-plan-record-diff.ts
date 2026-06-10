import useSWR from 'swr';
import { scratchApiClient } from '../lib/scratch-api-client';

/**
 * Three modes for the record diff on a publish plan:
 *   - `before-vs-after` (default): `main_pre_plan_{id}` → `main_plan_{id}`.
 *     "What this publish actually changed in the canonical state."
 *   - `after-vs-current`: `main_plan_{id}` → `main` (current HEAD).
 *     "Has the canonical record drifted since this publish landed?"
 *   - `before-vs-approved`: `main_pre_plan_{id}` → `dirty_plan_{id}`.
 *     "What the user wanted published when the plan ran."
 *
 * Either side can be null when the file didn't exist on that ref (newly
 * created records have no `main_pre` content; deletes have no later-side
 * content). Old plans that pre-date the `main_pre_plan_*` tag will return
 * null on the original side — the diff will then look like a full add.
 */
export type PlanRecordDiffMode = 'before-vs-after' | 'after-vs-current' | 'before-vs-approved';

function refsForMode(mode: PlanRecordDiffMode, planId: string): { original: string; modified: string } {
  switch (mode) {
    case 'before-vs-after':
      return { original: `main_pre_plan_${planId}`, modified: `main_plan_${planId}` };
    case 'after-vs-current':
      return { original: `main_plan_${planId}`, modified: `main` };
    case 'before-vs-approved':
      return { original: `main_pre_plan_${planId}`, modified: `dirty_plan_${planId}` };
  }
}

export function usePublishPlanRecordDiff(
  workbookId: string | undefined,
  planId: string | undefined,
  connectorAccountId: string | null | undefined,
  filePath: string | undefined,
  enabled: boolean,
  mode: PlanRecordDiffMode = 'before-vs-after',
) {
  const canFetch = !!workbookId && !!planId && !!connectorAccountId && !!filePath && enabled;
  const { data, error, isLoading, isValidating } = useSWR<{ original: string | null; modified: string | null }, Error>(
    canFetch ? ['publish-plan-record-diff', workbookId, planId, connectorAccountId, filePath, mode] : null,
    async () => {
      if (!workbookId || !planId || !filePath || !connectorAccountId) {
        throw new Error('workbookId, planId, filePath, and connectorAccountId are required');
      }
      const refs = refsForMode(mode, planId);
      const [originalRes, modifiedRes] = await Promise.allSettled([
        scratchApiClient.git.getRepoFileOrNull(workbookId, filePath, refs.original, connectorAccountId),
        scratchApiClient.git.getRepoFileOrNull(workbookId, filePath, refs.modified, connectorAccountId),
      ]);
      return {
        original: originalRes.status === 'fulfilled' ? (originalRes.value?.content ?? null) : null,
        modified: modifiedRes.status === 'fulfilled' ? (modifiedRes.value?.content ?? null) : null,
      };
    },
    {
      // Keep the previously-rendered diff visible while a new mode is
      // fetching — avoids the panel flashing empty when the user toggles
      // the SegmentedControl.
      keepPreviousData: true,
    },
  );

  return {
    original: data?.original ?? null,
    modified: data?.modified ?? null,
    error,
    isLoading,
    isValidating,
  };
}

/**
 * Independent fetch of "does the current main differ from the
 * post-publish state captured by this plan?" Used to warn the user that
 * the After Publish side they're looking at is no longer the canonical
 * value. Returns `null` while loading or when either ref is missing.
 */
export function usePublishPlanPostDiffersFromCurrent(
  workbookId: string | undefined,
  planId: string | undefined,
  connectorAccountId: string | null | undefined,
  filePath: string | undefined,
  enabled: boolean,
): { differs: boolean | null; isLoading: boolean } {
  const canFetch = !!workbookId && !!planId && !!connectorAccountId && !!filePath && enabled;
  const { data, isLoading } = useSWR<{ differs: boolean | null }, Error>(
    canFetch ? ['publish-plan-post-vs-current', workbookId, planId, connectorAccountId, filePath] : null,
    async () => {
      if (!workbookId || !planId || !filePath || !connectorAccountId) {
        throw new Error('workbookId, planId, filePath, and connectorAccountId are required');
      }
      const [postRes, currentRes] = await Promise.allSettled([
        scratchApiClient.git.getRepoFileOrNull(workbookId, filePath, `main_plan_${planId}`, connectorAccountId),
        scratchApiClient.git.getRepoFileOrNull(workbookId, filePath, 'main', connectorAccountId),
      ]);
      const post = postRes.status === 'fulfilled' ? (postRes.value?.content ?? null) : null;
      const current = currentRes.status === 'fulfilled' ? (currentRes.value?.content ?? null) : null;
      if (post === null || current === null) return { differs: null };
      return { differs: post !== current };
    },
  );

  return { differs: data?.differs ?? null, isLoading };
}
