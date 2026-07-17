import { Type } from '@sinclair/typebox';
import { PostgresColumnType, X_SCRATCH_CONNECTOR_DATA_TYPE } from '@spinner/shared-types';
import { BaseJsonTableSpec, dotPath } from '../../../types';
import {
  collectPgColumnNamesRejectingEmptyString,
  replaceEmptyStringsWithNullForPgTypedColumns,
} from '../pg-empty-string-coercion';

function annotated(pgType: PostgresColumnType) {
  return Type.Union([Type.Unknown(), Type.Null()], { [X_SCRATCH_CONNECTOR_DATA_TYPE]: pgType });
}

function buildTableSpec(): BaseJsonTableSpec {
  return {
    id: { wsId: 'records', remoteId: ['public', 'records'] },
    slug: 'records',
    name: 'records',
    schema: Type.Object({
      id: annotated(PostgresColumnType.NUMERIC),
      name: annotated(PostgresColumnType.TEXT),
      // A nullable timestamp is wrapped in Type.Optional by the connector; the
      // annotation must still be readable through that wrapper.
      close_date: Type.Optional(annotated(PostgresColumnType.TIMESTAMP)),
      revenue: annotated(PostgresColumnType.NUMERIC),
      is_active: annotated(PostgresColumnType.BOOLEAN),
      metadata: annotated(PostgresColumnType.JSONB),
      tags: annotated(PostgresColumnType.TEXT_ARRAY),
    }),
    idPath: dotPath('id'),
  };
}

describe('collectPgColumnNamesRejectingEmptyString', () => {
  it('collects timestamp/numeric/boolean/jsonb columns and excludes text/text[] columns', () => {
    const names = collectPgColumnNamesRejectingEmptyString(buildTableSpec());
    expect(names).toEqual(new Set(['id', 'close_date', 'revenue', 'is_active', 'metadata']));
    expect(names.has('name')).toBe(false);
    expect(names.has('tags')).toBe(false);
  });

  it('returns an empty set for a schema without connector-data-type annotations', () => {
    const spec: BaseJsonTableSpec = {
      id: { wsId: 'r', remoteId: ['public', 'r'] },
      slug: 'r',
      name: 'r',
      schema: Type.Object({ id: Type.Number(), name: Type.String() }),
      idPath: dotPath('id'),
    };
    expect(collectPgColumnNamesRejectingEmptyString(spec).size).toBe(0);
  });
});

describe('replaceEmptyStringsWithNullForPgTypedColumns', () => {
  const columns = new Set(['close_date', 'revenue', 'is_active', 'metadata']);

  it('replaces empty strings in the given columns with null', () => {
    const result = replaceEmptyStringsWithNullForPgTypedColumns(
      { name: 'x', close_date: '', revenue: '', is_active: '', metadata: '' },
      columns,
    );
    expect(result).toEqual({ name: 'x', close_date: null, revenue: null, is_active: null, metadata: null });
  });

  it('leaves non-empty and non-listed values untouched', () => {
    const record = { name: '', close_date: '2026-01-01T00:00:00.000Z', revenue: 0, is_active: false };
    const result = replaceEmptyStringsWithNullForPgTypedColumns(record, columns);
    // `name` is not in the set so its empty string is preserved; real values pass through.
    expect(result).toEqual({ name: '', close_date: '2026-01-01T00:00:00.000Z', revenue: 0, is_active: false });
  });

  it('returns the same object reference (no clone) when nothing is coerced', () => {
    const record = { name: 'x', close_date: '2026-01-01T00:00:00.000Z' };
    expect(replaceEmptyStringsWithNullForPgTypedColumns(record, columns)).toBe(record);
  });

  it('returns the same object reference when the column set is empty', () => {
    const record = { close_date: '' };
    expect(replaceEmptyStringsWithNullForPgTypedColumns(record, new Set())).toBe(record);
  });

  it('does not mutate the input record when coercing', () => {
    const record = { close_date: '', revenue: 5 };
    replaceEmptyStringsWithNullForPgTypedColumns(record, columns);
    expect(record.close_date).toBe('');
  });
});
