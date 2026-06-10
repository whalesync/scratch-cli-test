import type { Http } from '../http';

export interface VerifyDeviceAuthResponse {
  success?: boolean;
  error?: string;
}

export function createCliAuthApi(http: Http) {
  return {
    /**
     * Verify a CLI device authorization code.
     * Called from the web UI when a logged-in user enters the code.
     */
    verifyCliDeviceAuth: async (userCode: string): Promise<VerifyDeviceAuthResponse> => {
      const res = await http.post<VerifyDeviceAuthResponse>('/cli/v1/auth/verify', { userCode });
      return res.data;
    },
  };
}

export type CliAuthApi = ReturnType<typeof createCliAuthApi>;
