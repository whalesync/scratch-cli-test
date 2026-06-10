import type { DesktopReleaseResponse } from '../../dto/desktop-release/desktop-release.dto';
import type { Http } from '../http';

export function createDesktopReleaseApi(http: Http) {
  return {
    getLatest: async (): Promise<DesktopReleaseResponse> => {
      const res = await http.get<DesktopReleaseResponse>('/desktop-release/latest', {
        fallbackMessage: 'Failed to fetch latest desktop release',
      });
      return res.data;
    },

    getLatestCli: async (): Promise<DesktopReleaseResponse> => {
      const res = await http.get<DesktopReleaseResponse>('/desktop-release/cli/latest', {
        fallbackMessage: 'Failed to fetch latest CLI release',
      });
      return res.data;
    },
  };
}

export type DesktopReleaseApi = ReturnType<typeof createDesktopReleaseApi>;
