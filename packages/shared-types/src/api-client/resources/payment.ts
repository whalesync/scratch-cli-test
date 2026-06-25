import type {
  CreateCheckoutSessionBody,
  CreateCheckoutSessionResponse,
} from '../../dto/payment/create-checkout-session.dto';
import type { CreateCustomerPortalUrlResponse, CreatePortalDto } from '../../dto/payment/create-portal.dto';
import type { SubscriptionPlan } from '../../subscription';
import type { Http } from '../http';

/**
 * Billing/payment operations — Stripe customer-portal links, checkout sessions, and the plan
 * catalog. Reached as `client.payment.*` from both the web client and the desktop app (DEV-10538);
 * the desktop opens the returned Stripe URL in the system browser and is sent back via a deep link.
 */
export function createPaymentApi(http: Http) {
  return {
    createCustomerPortalUrl: async (dto: CreatePortalDto): Promise<CreateCustomerPortalUrlResponse> => {
      const res = await http.post<CreateCustomerPortalUrlResponse>('/payment/portal', dto, {
        fallbackMessage: 'Failed to create customer portal url',
      });
      return res.data;
    },

    createCheckoutSession: async (
      planType: string,
      dto: CreateCheckoutSessionBody,
    ): Promise<CreateCheckoutSessionResponse> => {
      const res = await http.post<CreateCheckoutSessionResponse>(`/payment/checkout/${planType}`, dto, {
        fallbackMessage: `Failed to create checkout session for ${planType}`,
      });
      return res.data;
    },

    listPlans: async (): Promise<SubscriptionPlan[]> => {
      const res = await http.get<SubscriptionPlan[]>('/payment/plans', {
        fallbackMessage: 'Failed to list billing plans',
      });
      return res.data;
    },
  };
}

export type PaymentApi = ReturnType<typeof createPaymentApi>;
