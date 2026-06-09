import { ScratchPlanType } from '@spinner/shared-types';

export interface CreateCustomerPortalUrlResponse {
  /** Url to redirect the user to. */
  url: string;
}

export interface CreateCheckoutSessionResponse {
  /** Url to redirect the user to. */
  url: string;
}

export interface CreatePortalDto {
  portalType?: 'cancel_subscription' | 'update_subscription' | 'manage_payment_methods';
  returnPath?: string;
  planType?: ScratchPlanType;
}
