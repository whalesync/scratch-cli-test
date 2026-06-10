import type {
  DeviceCodeInitiateResponse,
  DeviceCodePollDto,
  DeviceCodePollResponse,
} from '../../dto/cli-auth/device-code.dto';
import type { Http } from '../http';

/**
 * Device-code authentication. These endpoints are reached with NO `Authorization` header, so
 * this namespace is constructed with the unauthenticated {@link Http} handle.
 */
export function createAuthApi(httpUnauthenticated: Http) {
  return {
    initiateDeviceCode: async (): Promise<DeviceCodeInitiateResponse> => {
      const res = await httpUnauthenticated.post<DeviceCodeInitiateResponse>('/cli/v1/auth/initiate', undefined, {
        fallbackMessage: 'Failed to initiate authentication',
      });
      return res.data;
    },

    pollDeviceCode: async (
      dto: DeviceCodePollDto,
      options?: { signal?: AbortSignal },
    ): Promise<DeviceCodePollResponse> => {
      const res = await httpUnauthenticated.post<DeviceCodePollResponse>('/cli/v1/auth/poll', dto, {
        signal: options?.signal,
        fallbackMessage: 'Failed to poll for authentication',
      });
      return res.data;
    },
  };
}

export type AuthApi = ReturnType<typeof createAuthApi>;
