import type { DecryptedCredentials } from '../../connector/credentials';
import type { User } from '../../db/user';
import type { ChangeUserOrganizationDto } from '../../dto/dev-tools/change-user-organization.dto';
import type { GetAllJobsResponseDto } from '../../dto/dev-tools/get-all-jobs.dto';
import type { UserDetails } from '../../dto/dev-tools/user-detail.dto';
import type { UpdateSettingsDto } from '../../dto/users/update-settings.dto';
import type { AdminWorkbookDto } from '../../dto/workbook/admin-workbook.dto';
import type { EmailTemplate, EmailTemplatePayload } from '../../email';
import type { ScratchPlanType } from '../../subscription';
import type { Http } from '../http';

/**
 * Developer-tools admin surface: user search/details, organization & subscription mutations,
 * connection credential inspection, waitlist management, test emails, and job listings.
 * Reached as `client.devTools.*`.
 */
export function createDevToolsApi(http: Http) {
  return {
    searchUsers: async (query: string): Promise<User[]> => {
      const res = await http.get<User[]>('/dev-tools/users/search', {
        params: { query },
        fallbackMessage: 'Failed to search users with query: ' + query,
      });
      return res.data;
    },

    getUserDetails: async (userId: string): Promise<UserDetails> => {
      const res = await http.get<UserDetails>(`/dev-tools/users/${userId}/details`, {
        fallbackMessage: 'Failed to get user info for user: ' + userId,
      });
      return res.data;
    },

    updateUserSettings: async (userId: string, dto: UpdateSettingsDto): Promise<void> => {
      await http.patch(`/dev-tools/users/${userId}/settings`, dto, {
        fallbackMessage: 'Failed to update user settings for user: ' + userId,
      });
    },

    changeUserOrganization: async (dto: ChangeUserOrganizationDto): Promise<void> => {
      await http.post('/dev-tools/users/change-organization', dto, {
        fallbackMessage: 'Failed to change user organization',
      });
    },

    updateUserSubscription: async (newPlan: ScratchPlanType): Promise<void> => {
      await http.post(
        '/dev-tools/subscription/plan/update',
        { planType: newPlan },
        { fallbackMessage: 'Failed to update user subscription' },
      );
    },

    forceExpireSubscription: async (): Promise<void> => {
      await http.post('/dev-tools/subscription/plan/expire', undefined, {
        fallbackMessage: 'Failed to force expire subscription',
      });
    },

    forceCancelSubscription: async (): Promise<void> => {
      await http.post('/dev-tools/subscription/plan/cancel', undefined, {
        fallbackMessage: 'Failed to force cancel subscription',
      });
    },

    getConnectionCredentials: async (
      connectionId: string,
    ): Promise<{ id: string; service: string; credentials: Partial<DecryptedCredentials> }> => {
      const res = await http.get<{ id: string; service: string; credentials: Partial<DecryptedCredentials> }>(
        `/dev-tools/connections/${connectionId}`,
        { fallbackMessage: 'Failed to get credentials for connection: ' + connectionId },
      );
      return res.data;
    },

    getWaitlistPending: async (): Promise<User[]> => {
      const res = await http.get<User[]>('/dev-tools/users/waitlist-pending', {
        fallbackMessage: 'Failed to fetch waitlist pending users',
      });
      return res.data;
    },

    approveWaitlistUser: async (userId: string): Promise<void> => {
      await http.patch(`/dev-tools/users/${userId}/waitlist-approved`, undefined, {
        fallbackMessage: 'Failed to approve waitlist user',
      });
    },

    sendTestEmail: async <T extends EmailTemplate>(
      templateId: T,
      to: string,
      dynamicTemplateData: EmailTemplatePayload[T],
    ): Promise<{ success: true }> => {
      const res = await http.post<{ success: true }>(
        '/dev-tools/email/send-test',
        {
          templateId,
          to,
          dynamicTemplateData,
        },
        { fallbackMessage: 'Failed to send test email' },
      );
      return res.data;
    },

    getAllJobs: async (params?: {
      limit?: number;
      offset?: number;
      statuses?: string[];
      userId?: string;
    }): Promise<GetAllJobsResponseDto> => {
      const res = await http.get<GetAllJobsResponseDto>('/dev-tools/jobs', {
        params: {
          limit: params?.limit,
          offset: params?.offset,
          statuses: params?.statuses?.join(','),
          userId: params?.userId,
        },
        fallbackMessage: 'Failed to fetch all jobs',
      });
      return res.data;
    },

    /** POST `/dev-tools/jobs/sync-data-folders` — queue a job to sync a workbook's data folders. */
    syncDataFolders: async (
      workbookId: string,
      syncId: string,
    ): Promise<{ success: boolean; jobId: string; message: string }> => {
      const res = await http.post<{ success: boolean; jobId: string; message: string }>(
        '/dev-tools/jobs/sync-data-folders',
        { workbookId, syncId },
        { fallbackMessage: 'Failed to queue sync-data-folders job' },
      );
      return res.data;
    },

    /** GET `/dev-tools/workbooks` — admin list of all workbooks with search/service filters. */
    adminListWorkbooks: async (params: {
      search?: string;
      services?: string[];
      serviceMode?: 'AND' | 'OR';
      limit?: number;
      offset?: number;
    }): Promise<{ workbooks: AdminWorkbookDto[]; total: number }> => {
      const res = await http.get<{ workbooks: AdminWorkbookDto[]; total: number }>('/dev-tools/workbooks', {
        params: {
          search: params.search || undefined,
          services: params.services?.length ? params.services.join(',') : undefined,
          serviceMode: params.serviceMode,
          limit: params.limit,
          offset: params.offset,
        },
        fallbackMessage: 'Failed to list workspaces',
      });
      return res.data;
    },

    /** GET `/dev-tools/workbooks/:id/export` — export a workbook as JSON. */
    exportWorkbookJson: async (workbookId: string): Promise<unknown> => {
      const res = await http.get(`/dev-tools/workbooks/${workbookId}/export`, {
        fallbackMessage: 'Failed to export workspace',
      });
      return res.data;
    },

    /** POST `/dev-tools/workbooks/import` — import a workbook from JSON. */
    importWorkbookJson: async (json: unknown): Promise<{ workbookId: string }> => {
      const res = await http.post<{ workbookId: string }>('/dev-tools/workbooks/import', json, {
        fallbackMessage: 'Failed to import workspace',
      });
      return res.data;
    },

    /** GET `/dev-tools/connections/:id/git-url` — clone URL + command for a connection's repo. */
    getConnectionGitUrl: async (connectorAccountId: string): Promise<{ gitUrl: string; gitCloneCommand: string }> => {
      const res = await http.get<{ gitUrl: string; gitCloneCommand: string }>(
        `/dev-tools/connections/${connectorAccountId}/git-url`,
        { fallbackMessage: 'Failed to get connection git URL' },
      );
      return res.data;
    },

    /** POST `/dev-tools/connections/:id/move-repo` — relocate a connection's repo on disk. */
    moveRepo: async (
      connectorAccountId: string,
      newRepoPath: string,
    ): Promise<{ success: boolean; oldRepoPath: string; newRepoPath: string }> => {
      const res = await http.post<{ success: boolean; oldRepoPath: string; newRepoPath: string }>(
        `/dev-tools/connections/${connectorAccountId}/move-repo`,
        { newRepoPath },
        { fallbackMessage: 'Failed to move repo' },
      );
      return res.data;
    },
  };
}

export type DevToolsApi = ReturnType<typeof createDevToolsApi>;
