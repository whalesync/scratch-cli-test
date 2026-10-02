import type { CreateFieldType, TableView, TableViewCol } from '@spinner/shared-types';
import knex, { type Knex } from 'knex';
import { selectPlanFieldsFromTableView } from 'src/schema-builder/schema-builder-field-selection';
import { inferLogicalFieldType, type InferredFieldType } from 'src/schema-builder/schema-builder-plan-generator';
import type { BaseJsonTableSpec, EntityId } from '../../../types';
import { buildAirtableCreateField } from '../../airtable/airtable-create-schema';
import { buildCreateTableQuery } from '../../pg-common/pg-create-schema';
import { buildGongDefaultView, type GongParsedTableId } from '../gong-default-view';
import {
  buildGongCallsJsonTableSpec,
  buildGongLibraryFoldersJsonTableSpec,
  buildGongScorecardsJsonTableSpec,
  buildGongTranscriptsJsonTableSpec,
  buildGongUsersJsonTableSpec,
  buildGongWorkspacesJsonTableSpec,
  gongTableWsId,
} from '../gong-json-schema';
import { GongEntityType, WORKSPACE_SCOPED_ENTITY_TYPES } from '../gong-types';

/**
 * End-to-end Live Export coverage for Gong's date columns: default view → plan field selection →
 * logical field type → the destination's native column.
 *
 * DEV-12085: a call's start time landed in Supabase as a date-only `date` column (and in Airtable as a
 * date field without a time), dropping the time of day from every call. The schema declares `format:
 * 'date-time'` on `metaData.started`, but the export layer never sees it: the Calls ROOT carries agent
 * instructions and `metaData` is flagged read-only, and the schema flattener (`extractSchemaFields`)
 * keeps any object carrying such an `x-scratch-*` annotation whole, as one opaque leaf. The Calls table
 * therefore yields no schema fields at all, and a date column there has to declare itself time-bearing.
 */

const WORKSPACE_ID = '1299375510811165803';
const WORKSPACE_NAME = 'Initial workspace';

const BUILD_GONG_TABLE_SPEC_BY_ENTITY_TYPE: Record<GongEntityType, (id: EntityId) => BaseJsonTableSpec> = {
  [GongEntityType.CALLS]: (id) => buildGongCallsJsonTableSpec(id, WORKSPACE_ID, WORKSPACE_NAME),
  [GongEntityType.TRANSCRIPTS]: (id) => buildGongTranscriptsJsonTableSpec(id, WORKSPACE_ID, WORKSPACE_NAME),
  [GongEntityType.USERS]: (id) => buildGongUsersJsonTableSpec(id),
  [GongEntityType.WORKSPACES]: (id) => buildGongWorkspacesJsonTableSpec(id),
  [GongEntityType.LIBRARY_FOLDERS]: (id) => buildGongLibraryFoldersJsonTableSpec(id, WORKSPACE_ID, WORKSPACE_NAME),
  [GongEntityType.SCORECARDS]: (id) => buildGongScorecardsJsonTableSpec(id, WORKSPACE_ID, WORKSPACE_NAME),
};

interface GongTableUnderExport {
  spec: BaseJsonTableSpec;
  parsedTableId: GongParsedTableId;
}

/** A Gong table as the connector lists it: workspace-scoped tables carry the workspace id in remoteId[1]. */
function gongTableUnderExport(entityType: GongEntityType): GongTableUnderExport {
  const isWorkspaceScoped = WORKSPACE_SCOPED_ENTITY_TYPES.has(entityType);
  const tableId: EntityId = isWorkspaceScoped
    ? { wsId: gongTableWsId(entityType, WORKSPACE_ID), remoteId: [entityType, WORKSPACE_ID] }
    : { wsId: gongTableWsId(entityType), remoteId: [entityType] };
  return {
    spec: BUILD_GONG_TABLE_SPEC_BY_ENTITY_TYPE[entityType](tableId),
    parsedTableId: isWorkspaceScoped ? { entityType, workspaceId: WORKSPACE_ID } : { entityType },
  };
}

const CALLS_TABLE = gongTableUnderExport(GongEntityType.CALLS);
const LIBRARY_FOLDERS_TABLE = gongTableUnderExport(GongEntityType.LIBRARY_FOLDERS);
const EVERY_GONG_TABLE = Object.values(GongEntityType).map(gongTableUnderExport);

function defaultViewFor(table: GongTableUnderExport): TableView {
  const view = buildGongDefaultView(table.spec, table.parsedTableId);
  if (!view) throw new Error(`Gong builds no default view for ${table.spec.name}`);
  return view;
}

function everyColumnIn(view: TableView): TableViewCol[] {
  return view.cols.flatMap((entry) => (entry.kind === 'banner-group' ? entry.cols : [entry]));
}

/** The view with nothing hidden — what the plan would offer if a user surfaced every column. */
function withEveryColumnVisible(view: TableView): TableView {
  return {
    ...view,
    cols: view.cols.map((entry) =>
      entry.kind === 'banner-group'
        ? { ...entry, hidden: false, cols: entry.cols.map((column) => ({ ...column, hidden: false })) }
        : { ...entry, hidden: false },
    ),
  };
}

function viewColumnAt(view: TableView, path: string): TableViewCol {
  const column = everyColumnIn(view).find((candidate) => candidate.path === path);
  if (!column) throw new Error(`No view column at ${path}`);
  return column;
}

/** Every path the plan would propose as a destination field — i.e. what the user is offered. */
function exportedPathsFor(table: GongTableUnderExport): string[] {
  return selectPlanFieldsFromTableView({
    schema: table.spec.schema,
    view: defaultViewFor(table),
    titlePath: table.spec.titlePath,
    idPath: table.spec.idPath,
  }).schemaFields.map((planField) => planField.path);
}

/** The logical field type (and mapping status) the schema builder would give the destination field at `path`. */
function inferredFieldTypeFor(
  table: GongTableUnderExport,
  path: string,
  view: TableView = defaultViewFor(table),
): InferredFieldType {
  const { schemaFields, viewTypeByPath } = selectPlanFieldsFromTableView({
    schema: table.spec.schema,
    view,
    titlePath: table.spec.titlePath,
    idPath: table.spec.idPath,
  });
  const planField = schemaFields.find((candidate) => candidate.path === path);
  if (!planField) throw new Error(`No plan field at ${path} — it is not offered for export`);
  return inferLogicalFieldType(planField, viewTypeByPath[path], 'Gong');
}

/** The native Airtable field type the destination pack would create for a column. */
function airtableFieldTypeFor(destinationFieldName: string, fieldType: CreateFieldType): string {
  const built = buildAirtableCreateField({ name: destinationFieldName, fieldType }, { baseId: 'appBASE' });
  if ('skip' in built) throw new Error(`Airtable skipped ${destinationFieldName}: ${built.skip}`);
  return built.field.type;
}

// Connection-less Knex: builds the CREATE TABLE a Postgres / Supabase destination would run, with no database.
const postgresQueryBuilder: Knex = knex({ client: 'pg' });

afterAll(async () => {
  await postgresQueryBuilder.destroy();
});

function postgresCreateTableSqlFor(destinationFieldName: string, fieldType: CreateFieldType): string {
  return buildCreateTableQuery(
    postgresQueryBuilder,
    'public',
    'calls',
    [{ name: destinationFieldName, fieldType }],
    new Map(),
  )
    .toString()
    .toLowerCase();
}

describe('Calls "Started" keeps its time of day on every destination (DEV-12085)', () => {
  it('declares the column time-bearing on the view, since the schema format never reaches the plan', () => {
    expect(viewColumnAt(defaultViewFor(CALLS_TABLE), 'metaData.started')).toMatchObject({
      type: 'date',
      logicalType: 'datetime',
    });
  });

  it('plans a time-bearing date field, cleanly mapped', () => {
    expect(inferredFieldTypeFor(CALLS_TABLE, 'metaData.started')).toEqual({
      status: 'mapped',
      fieldType: { kind: 'date', includesTime: true },
    });
  });

  it('becomes an Airtable dateTime field', () => {
    const { fieldType } = inferredFieldTypeFor(CALLS_TABLE, 'metaData.started');

    expect(airtableFieldTypeFor('Started', fieldType)).toBe('dateTime');
  });

  it('becomes a Postgres / Supabase timestamptz column, not a date', () => {
    const { fieldType } = inferredFieldTypeFor(CALLS_TABLE, 'metaData.started');
    const createTableSql = postgresCreateTableSqlFor('Started', fieldType);

    expect(createTableSql).toContain('"started" timestamptz');
    expect(createTableSql).not.toContain('"started" date');
  });

  it('keeps the hidden "Scheduled" column out of the plan, but time-bearing once a user surfaces it', () => {
    expect(exportedPathsFor(CALLS_TABLE)).not.toContain('metaData.scheduled');

    const everyColumnVisibleCallsView = withEveryColumnVisible(defaultViewFor(CALLS_TABLE));
    expect(inferredFieldTypeFor(CALLS_TABLE, 'metaData.scheduled', everyColumnVisibleCallsView).fieldType).toEqual({
      kind: 'date',
      includesTime: true,
    });
  });
});

describe('control: a date on a table whose schema root is clean gets its time from the schema format alone', () => {
  it('Library Folders "Updated" needs no view annotation', () => {
    expect(viewColumnAt(defaultViewFor(LIBRARY_FOLDERS_TABLE), 'updated').logicalType).toBeUndefined();
    expect(inferredFieldTypeFor(LIBRARY_FOLDERS_TABLE, 'updated').fieldType).toEqual({
      kind: 'date',
      includesTime: true,
    });
  });
});

describe('every Gong date column exports with its time of day', () => {
  // Gong returns every date as a full ISO-8601 date-time, so a date-only destination column is always lossy.
  // Every column is un-hidden first, so a hidden date a user surfaces is guarded too.
  function exportedDateColumnsAcrossEveryGongTable(): { column: string; fieldType: CreateFieldType }[] {
    return EVERY_GONG_TABLE.flatMap((table) => {
      const everyColumnVisibleView = withEveryColumnVisible(defaultViewFor(table));
      return everyColumnIn(everyColumnVisibleView)
        .filter((column) => [column.type, column.logicalType].some((type) => type === 'date' || type === 'datetime'))
        .map((column) => ({
          column: `${table.spec.name} › ${column.path}`,
          fieldType: inferredFieldTypeFor(table, column.path, everyColumnVisibleView).fieldType,
        }));
    });
  }

  it('finds the date columns it guards', () => {
    expect(exportedDateColumnsAcrossEveryGongTable().map((entry) => entry.column)).toEqual(
      expect.arrayContaining([
        'Calls › metaData.started',
        'Calls › metaData.scheduled',
        'Users › created',
        'Library Folders › updated',
        'Scorecards › created',
        'Scorecards › updated',
      ]),
    );
  });

  it('creates a time-bearing destination field for each of them', () => {
    for (const { column, fieldType } of exportedDateColumnsAcrossEveryGongTable()) {
      expect({ column, fieldType }).toEqual({ column, fieldType: { kind: 'date', includesTime: true } });
    }
  });
});
