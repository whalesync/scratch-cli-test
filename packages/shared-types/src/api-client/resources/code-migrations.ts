import type {
  AvailableMigrationsResponse,
  MigrationResult,
  RunMigrationDto,
} from '../../dto/code-migrations/code-migrations.dto';
import type { Http } from '../http';

export function createCodeMigrationsApi(http: Http) {
  return {
    getAvailableMigrations: async (): Promise<AvailableMigrationsResponse> => {
      const res = await http.get<AvailableMigrationsResponse>('/code-migrations/available', {
        fallbackMessage: 'Failed to fetch available migrations',
      });
      return res.data;
    },

    runMigration: async (request: RunMigrationDto): Promise<MigrationResult> => {
      const res = await http.post<MigrationResult>('/code-migrations/run', request, {
        fallbackMessage: 'Failed to run migration',
      });
      return res.data;
    },
  };
}

export type CodeMigrationsApi = ReturnType<typeof createCodeMigrationsApi>;
