import type {
  CreateSchemaFieldsResponse,
  CreateSchemaTablesResponse,
  GenerateCreatePlanResponse,
  ValidateSchemaResponse,
} from '../../dto/schema/create-schema-responses.dto';
import type {
  CreateSchemaFieldsDto,
  CreateSchemaTablesDto,
  GenerateCreatePlanDto,
} from '../../dto/schema/create-schema.dto';
import type { Http } from '../http';

/**
 * Create-schema API (DEV-10378): create new tables and fields on a remote data source through a
 * connector, in a connector-agnostic logical vocabulary. All routes hang off
 * `/workbook/:workbookId/schema/...`. Reached at the `client.schema.*` root.
 *
 * Composition mirrors the server: `planFromFolder` (derive an editable plan from existing source
 * folders) → `validate` (dry-run, never touches the remote) → `createTables` / `createFields`
 * (execute). `validate` accepts the same body as `createTables`.
 */
export function createSchemaApi(http: Http) {
  return {
    planFromFolder: async (workbookId: string, body: GenerateCreatePlanDto): Promise<GenerateCreatePlanResponse> => {
      const res = await http.post<GenerateCreatePlanResponse>(`/workbook/${workbookId}/schema/plan-from-folder`, body, {
        fallbackMessage: 'Failed to generate a create-schema plan',
      });
      return res.data;
    },

    validate: async (workbookId: string, body: CreateSchemaTablesDto): Promise<ValidateSchemaResponse> => {
      const res = await http.post<ValidateSchemaResponse>(`/workbook/${workbookId}/schema/validate`, body, {
        fallbackMessage: 'Failed to validate the schema plan',
      });
      return res.data;
    },

    createTables: async (workbookId: string, body: CreateSchemaTablesDto): Promise<CreateSchemaTablesResponse> => {
      const res = await http.post<CreateSchemaTablesResponse>(`/workbook/${workbookId}/schema/tables`, body, {
        fallbackMessage: 'Failed to create tables',
      });
      return res.data;
    },

    createFields: async (workbookId: string, body: CreateSchemaFieldsDto): Promise<CreateSchemaFieldsResponse> => {
      const res = await http.post<CreateSchemaFieldsResponse>(`/workbook/${workbookId}/schema/fields`, body, {
        fallbackMessage: 'Failed to create fields',
      });
      return res.data;
    },
  };
}

export type SchemaApi = ReturnType<typeof createSchemaApi>;
