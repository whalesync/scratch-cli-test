import { RunMigrationDto, type AvailableMigrationsResponse, type MigrationResult } from '@spinner/shared-types';
import { validateHelper } from '../../utils/validate-helper';
import { API_CONFIG } from './config';
import { handleAxiosError } from './error';

export const codeMigrationsApi = {
  getAvailableMigrations: async (): Promise<AvailableMigrationsResponse> => {
    try {
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.get<AvailableMigrationsResponse>('/code-migrations/available');
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to fetch available migrations');
    }
  },

  runMigration: async (request: RunMigrationDto): Promise<MigrationResult> => {
    try {
      await validateHelper(Object.assign(new RunMigrationDto(), request));
      const axios = API_CONFIG.getAxiosInstance();
      const res = await axios.post<MigrationResult>('/code-migrations/run', request);
      return res.data;
    } catch (error) {
      handleAxiosError(error, 'Failed to run migration');
    }
  },
};
