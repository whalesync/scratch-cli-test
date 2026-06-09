import {
  CreateCheckoutSessionResponse,
  CreateCustomerPortalUrlResponse,
  CreatePortalDto,
} from '@/types/server-entities/payment';
import { CreateCheckoutSessionBody, SubscriptionPlan } from '@spinner/shared-types';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const paymentApi = {
  createCustomerPortalUrl: async (dto: CreatePortalDto): Promise<CreateCustomerPortalUrlResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<CreateCustomerPortalUrlResponse>('/payment/portal', dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to create customer portal url');
    }
  },

  createCheckoutSession: async (
    planType: string,
    dto: CreateCheckoutSessionBody,
  ): Promise<CreateCheckoutSessionResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<CreateCheckoutSessionResponse>(`/payment/checkout/${planType}`, dto);
      return res.data;
    } catch (error) {
      handleAxiosError(error, `Failed to create checkout session for ${planType}`);
    }
  },

  listPlans: async (): Promise<SubscriptionPlan[]> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<SubscriptionPlan[]>('/payment/plans');
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to list billing plans');
    }
  },
};
