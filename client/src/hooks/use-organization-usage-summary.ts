import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { OrganizationUsageSummaryResponseDto } from '@spinner/shared-types';
import { isUnauthorizedError } from '@spinner/shared-types/api-client';
import { useMemo } from 'react';
import useSWR from 'swr';

export interface UseOrganizationUsageSummaryReturn {
  /** Org-wide workbook count, record total, and connector services in use; `undefined` while loading. */
  summary: OrganizationUsageSummaryResponseDto | undefined;
  isLoading: boolean;
  error: string | undefined;
}

/**
 * Loads the organization-wide usage summary (`GET /workbook/organization-usage-summary`) for the
 * billing page. Org-scoped on the server (by `Workbook.organizationId`), so the workbook count and
 * connector icons match the org-wide record total — unlike the membership-scoped workspace list.
 */
export const useOrganizationUsageSummary = (): UseOrganizationUsageSummaryReturn => {
  const { data, error, isLoading } = useSWR<OrganizationUsageSummaryResponseDto, Error>(
    SWR_KEYS.workbook.organizationUsageSummary(),
    () => scratchApiClient.workspaces.organizationUsageSummary(),
  );

  const displayError = useMemo(() => {
    if (isUnauthorizedError(error)) {
      // ignore this error as it will be fixed after the token is refreshed
      return undefined;
    }
    return error?.message;
  }, [error]);

  return {
    summary: data,
    isLoading,
    error: displayError,
  };
};
