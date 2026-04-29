import { UserDetails } from '@/types/server-entities/dev-tools';
import { UpdateSettingsDto, User } from '@/types/server-entities/users';
import {
  ChangeUserOrganizationDto,
  ConnectorAccountId,
  DecryptedCredentials,
  EmailTemplate,
  EmailTemplatePayload,
  GetAllJobsResponseDto,
  ScratchPlanType,
} from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

/**
 * API for developer tools
 */
export const devToolsApi = {
  searchUsers: async (query: string): Promise<User[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<User[]>('/dev-tools/users/search', {
        params: { query },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to search users with query: ' + query);
    }
  },
  getUserDetails: async (userId: string): Promise<UserDetails> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<UserDetails>(`/dev-tools/users/${userId}/details`);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get user info for user: ' + userId);
    }
  },
  updateUserSettings: async (userId: string, dto: UpdateSettingsDto): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.patch(`/dev-tools/users/${userId}/settings`, dto);
    } catch (error) {
      handleAxiosError(error, 'Failed to update user settings for user: ' + userId);
    }
  },
  changeUserOrganization: async (dto: ChangeUserOrganizationDto): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post('/dev-tools/users/change-organization', dto);
    } catch (error) {
      handleAxiosError(error, 'Failed to change user organization');
    }
  },
  updateUserSubscription: async (newPlan: ScratchPlanType): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post('/dev-tools/subscription/plan/update', { planType: newPlan });
    } catch (error) {
      handleAxiosError(error, 'Failed to update user subscription');
    }
  },
  forceExpireSubscription: async (): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post('/dev-tools/subscription/plan/expire');
    } catch (error) {
      handleAxiosError(error, 'Failed to force expire subscription');
    }
  },
  forceCancelSubscription: async (): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.post('/dev-tools/subscription/plan/cancel');
    } catch (error) {
      handleAxiosError(error, 'Failed to force cancel subscription');
    }
  },
  getConnectionCredentials: async (
    connectionId: ConnectorAccountId,
  ): Promise<{ id: string; service: string; credentials: Partial<DecryptedCredentials> }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<{ id: string; service: string; credentials: Partial<DecryptedCredentials> }>(
        `/dev-tools/connections/${connectionId}`,
      );
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to get credentials for connection: ' + connectionId);
    }
  },
  getWaitlistPending: async (): Promise<User[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<User[]>('/dev-tools/users/waitlist-pending');
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch waitlist pending users');
    }
  },

  approveWaitlistUser: async (userId: string): Promise<void> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      await axios.patch(`/dev-tools/users/${userId}/waitlist-approved`);
    } catch (error) {
      handleAxiosError(error, 'Failed to approve waitlist user');
    }
  },

  sendTestEmail: async <T extends EmailTemplate>(
    templateId: T,
    to: string,
    dynamicTemplateData: EmailTemplatePayload[T],
  ): Promise<{ success: true }> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<{ success: true }>('/dev-tools/email/send-test', {
        templateId,
        to,
        dynamicTemplateData,
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to send test email');
    }
  },

  getAllJobs: async (params?: {
    limit?: number;
    offset?: number;
    statuses?: string[];
    userId?: string;
  }): Promise<GetAllJobsResponseDto> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<GetAllJobsResponseDto>('/dev-tools/jobs', {
        params: {
          limit: params?.limit,
          offset: params?.offset,
          statuses: params?.statuses?.join(','),
          userId: params?.userId,
        },
      });
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch all jobs');
    }
  },
};
