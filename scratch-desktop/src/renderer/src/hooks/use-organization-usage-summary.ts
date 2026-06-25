import { OrganizationUsageSummaryResponseDto } from '@spinner/shared-types';
import { isUnauthorizedError } from '@spinner/shared-types/api-client';
import { useMemo } from 'react';
import useSWR from 'swr';
import { scratchApiClient } from '../lib/scratch-api-client';

export interface UseOrganizationUsageSummaryReturn {
  /** Org-wide workbook count, record total, and connector services in use; `undefined` while loading. */
  summary: OrganizationUsageSummaryResponseDto | undefined;
  isLoading: boolean;
  error: string | undefined;
}

const ORGANIZATION_USAGE_SUMMARY_SWR_KEY = '/workbook/organization-usage-summary';

/**
 * Loads the organization-wide usage summary (`GET /workbook/organization-usage-summary`) for the desktop billing
 * page — org-scoped workbook count, record total, and connector services. Desktop counterpart of the web
 * client's `useOrganizationUsageSummary`.
 */
export const useOrganizationUsageSummary = (): UseOrganizationUsageSummaryReturn => {
  const { data, error, isLoading } = useSWR<OrganizationUsageSummaryResponseDto, Error>(
    ORGANIZATION_USAGE_SUMMARY_SWR_KEY,
    () => scratchApiClient.workspaces.organizationUsageSummary(),
  );

  const displayError = useMemo(() => {
    if (isUnauthorizedError(error)) {
      // Ignore — this resolves once the API token is refreshed.
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
