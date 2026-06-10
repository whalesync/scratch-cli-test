import { z } from 'zod';

/**
 * Device-code authentication contracts for the unauthenticated CLI/desktop login flow
 * (`POST /cli/v1/auth/initiate` then polling `POST /cli/v1/auth/poll`). These endpoints
 * are reached with NO `Authorization` header — see the api-client unauthenticated path.
 */

/** Response for `POST /cli/v1/auth/initiate`. */
export interface DeviceCodeInitiateResponse {
  userCode?: string;
  pollingCode?: string;
  verificationUrl?: string;
  expiresIn?: number;
  interval?: number;
  error?: string;
}

/** Request body for `POST /cli/v1/auth/poll`. */
export const deviceCodePollSchema = z.object({
  pollingCode: z.string(),
});
export type DeviceCodePollDto = z.infer<typeof deviceCodePollSchema>;

export type DeviceCodePollStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** Response for `POST /cli/v1/auth/poll`. */
export interface DeviceCodePollResponse {
  status: DeviceCodePollStatus;
  apiToken?: string;
  userEmail?: string;
  tokenExpiresAt?: string;
  error?: string;
}
