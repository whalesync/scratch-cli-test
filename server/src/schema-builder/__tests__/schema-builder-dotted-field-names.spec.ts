import { Type } from '@sinclair/typebox';
import { WorkbookId, type CreateFieldSpec } from '@spinner/shared-types';
import { Actor } from 'src/users/types';
import { type CreateSchemaFieldsDto } from '../dto/create-schema.dto';
import { SchemaBuilderService } from '../schema-builder.service';

/**
 * Field names that contain `.` — HubSpot labels like "No. of employees" become Live Export
 * column names verbatim, and a flat Postgres/Supabase schema keys each column by that name. The
 * existing-name check used to split the column's path on `.` and keep the last piece, so an
 * existing "No. of employees" column was known as " of employees": re-adding it slipped past the
 * check (and failed remotely as "already exists"), while a genuinely new "of employees" field was
 * wrongly rejected as a duplicate.
 */
describe('SchemaBuilderService.createFields existing-name check with dotted column names', () => {
  const WORKBOOK_ID = 'wkb_1' as WorkbookId;
  const ACTOR = { userId: 'u_1' } as unknown as Actor;
  const DESTINATION_CONNECTOR = 'coa_dest';
  const REMOTE_TABLE_ID = ['proj', 'public', 'contacts'];

  function buildService(existingColumnNames: string[]): SchemaBuilderService {
    const workbookService = { assertWritableWorkbook: jest.fn().mockResolvedValue({ id: WORKBOOK_ID }) };
    const connectorAccountService = {
      findOneByIdUnscoped: jest.fn().mockResolvedValue({ id: DESTINATION_CONNECTOR, workbookId: WORKBOOK_ID }),
    };
    const connectorService = { getConnector: jest.fn().mockResolvedValue({ service: 'SUPABASE' }) };
    const dataFolderService = {
      getStoredSchema: jest.fn().mockResolvedValue({
        schema: Type.Object(Object.fromEntries(existingColumnNames.map((name) => [name, Type.String()]))),
      }),
    };
    const db = { client: { dataFolder: { findFirst: jest.fn().mockResolvedValue({ id: 'dfd_contacts' }) } } };
    const constructorArgs = [
      workbookService,
      connectorAccountService,
      connectorService,
      dataFolderService,
      db,
      undefined,
    ] as unknown as ConstructorParameters<typeof SchemaBuilderService>;
    return new SchemaBuilderService(...constructorArgs);
  }

  function textField(name: string): CreateFieldSpec {
    return { name, fieldType: { kind: 'text' } };
  }

  async function issuesForCreatingFields(existingColumnNames: string[], fieldNames: string[]): Promise<unknown> {
    const dto = {
      connectorAccountId: DESTINATION_CONNECTOR,
      remoteTableId: REMOTE_TABLE_ID,
      fields: fieldNames.map(textField),
    } as unknown as CreateSchemaFieldsDto;
    try {
      await buildService(existingColumnNames).createFields(WORKBOOK_ID, dto, ACTOR);
    } catch (error) {
      return (error as { getResponse: () => { issues: unknown } }).getResponse().issues;
    }
    throw new Error('expected createFields to reject the request');
  }

  it('rejects re-adding an existing dotted column, and does not flag a new name that matches only its tail', async () => {
    const issues = await issuesForCreatingFields(['id', 'No. of employees'], ['of employees', 'No. of employees']);

    expect(issues).toEqual([expect.objectContaining({ path: 'fields[1].name', code: 'FIELD_NAME_ALREADY_EXISTS' })]);
  });
});
