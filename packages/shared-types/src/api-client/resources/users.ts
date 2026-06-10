import type { User } from '../../db';
import type { UpdateSettingsDto } from '../../dto/users/update-settings.dto';
import type { Http } from '../http';

export function createUsersApi(http: Http) {
  return {
    activeUser: async (): Promise<User> => {
      const res = await http.get<User>('/users/current', { fallbackMessage: 'Failed to fetch active user' });
      return res.data;
    },

    updateSettings: async (dto: UpdateSettingsDto): Promise<void> => {
      await http.patch('/users/current/settings', dto, { fallbackMessage: 'Failed to update user settings' });
    },

    generateApiToken: async (): Promise<{ apiToken: string }> => {
      const res = await http.post<{ apiToken: string }>('/users/current/api-token', undefined, {
        fallbackMessage: 'Failed to generate API token',
      });
      return res.data;
    },

    updateLastWorkbook: async (workbookId: string | null): Promise<void> => {
      await http.patch(
        '/users/current/last-workbook',
        { workbookId },
        { fallbackMessage: 'Failed to update last workbook' },
      );
    },

    requestAccess: async (): Promise<void> => {
      await http.post('/users/current/request-access', undefined, { fallbackMessage: 'Failed to request access' });
    },
  };
}

export type UsersApi = ReturnType<typeof createUsersApi>;
