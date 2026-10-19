import { Type, type TSchema } from '@sinclair/typebox';
import {
  PostgresColumnType,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_NATIVE_COLUMN_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { NonWritableFieldEditError, NonWritableFieldReason, nonWritableFieldEditErrorMessage } from '../../../error';
import { dotPath, type BaseJsonTableSpec } from '../../../types';
import { MySqlClientError, MySqlClientProblem } from '../mysql-client-error';
import {
  buildMySqlTableWriteProfile,
  buildMySqlUpdateChangeSetWithWholeTopLevelValues,
  mysqlNativeColumnTypeRejectsEmptyString,
  prepareRecordsForMySqlWrite,
  type MySqlTableWriteProfile,
} from '../mysql-record-preparation';

/** A column schema the way the MySQL read side annotates it (nullable union, family, native type). */
function annotatedMySqlColumnSchema(params: {
  valueSchema: TSchema;
  family: PostgresColumnType;
  nativeColumnType?: string;
  isReadOnly?: boolean;
}): TSchema {
  return Type.Union([params.valueSchema, Type.Null()], {
    [X_SCRATCH_CONNECTOR_DATA_TYPE]: params.family,
    ...(params.nativeColumnType !== undefined
      ? {
          [X_SCRATCH_NATIVE_COLUMN_TYPE]: {
            typeSystem: 'mysql',
            type: params.nativeColumnType,
            isRecreatableVerbatim: false,
          },
        }
      : {}),
    ...(params.isReadOnly ? { [X_SCRATCH_READONLY]: true } : {}),
  });
}

function buildTableSpecWithColumns(
  idColumnName: string,
  columnSchemaByName: Record<string, TSchema>,
): BaseJsonTableSpec {
  return {
    id: { wsId: 'test_db__deals', remoteId: ['test_db', 'deals'] },
    slug: 'deals',
    name: 'deals',
    schema: Type.Object(columnSchemaByName),
    idPath: dotPath(idColumnName),
  };
}

const DEALS_TABLE_SPEC = buildTableSpecWithColumns('id', {
  id: annotatedMySqlColumnSchema({
    valueSchema: Type.String(),
    family: PostgresColumnType.NUMERIC_STRING,
    nativeColumnType: 'bigint unsigned',
    isReadOnly: true,
  }),
  title: annotatedMySqlColumnSchema({
    valueSchema: Type.String(),
    family: PostgresColumnType.TEXT,
    nativeColumnType: 'varchar(255)',
  }),
  notes: annotatedMySqlColumnSchema({
    valueSchema: Type.String(),
    family: PostgresColumnType.TEXT,
    nativeColumnType: 'mediumtext',
  }),
  stage: annotatedMySqlColumnSchema({
    valueSchema: Type.String(),
    family: PostgresColumnType.TEXT,
    nativeColumnType: "enum('open','won','')",
  }),
  amount: annotatedMySqlColumnSchema({
    valueSchema: Type.String(),
    family: PostgresColumnType.NUMERIC_STRING,
    nativeColumnType: 'decimal(10,2)',
  }),
  probability: annotatedMySqlColumnSchema({
    valueSchema: Type.Number(),
    family: PostgresColumnType.NUMERIC,
    nativeColumnType: 'int',
  }),
  is_hot: annotatedMySqlColumnSchema({
    valueSchema: Type.Number(),
    family: PostgresColumnType.NUMERIC,
    nativeColumnType: 'tinyint(1)',
  }),
  meta: annotatedMySqlColumnSchema({
    valueSchema: Type.Unknown(),
    family: PostgresColumnType.JSONB,
    nativeColumnType: 'json',
  }),
  closes_on: annotatedMySqlColumnSchema({
    valueSchema: Type.String({ format: 'date' }),
    family: PostgresColumnType.TIMESTAMP,
    nativeColumnType: 'date',
  }),
  closed_at: annotatedMySqlColumnSchema({
    valueSchema: Type.String({ format: 'date-time-local' }),
    family: PostgresColumnType.TIMESTAMP,
    nativeColumnType: 'datetime(3)',
  }),
  created_at: annotatedMySqlColumnSchema({
    valueSchema: Type.String({ format: 'date-time-local' }),
    family: PostgresColumnType.TIMESTAMP,
    nativeColumnType: 'datetime',
  }),
  synced_at: annotatedMySqlColumnSchema({
    valueSchema: Type.String({ format: 'date-time' }),
    family: PostgresColumnType.TIMESTAMP,
    nativeColumnType: 'timestamp(6)',
  }),
  call_time: annotatedMySqlColumnSchema({
    valueSchema: Type.String(),
    family: PostgresColumnType.TEXT,
    nativeColumnType: 'time',
  }),
  call_duration_with_milliseconds: annotatedMySqlColumnSchema({
    valueSchema: Type.String(),
    family: PostgresColumnType.TEXT,
    nativeColumnType: 'time(3)',
  }),
  fiscal_year: annotatedMySqlColumnSchema({
    valueSchema: Type.Number(),
    family: PostgresColumnType.NUMERIC,
    nativeColumnType: 'year',
  }),
  external_uuid: annotatedMySqlColumnSchema({
    valueSchema: Type.String(),
    family: PostgresColumnType.TEXT,
    nativeColumnType: 'uuid',
  }),
  attachment: annotatedMySqlColumnSchema({
    valueSchema: Type.String({ contentEncoding: 'base64' }),
    family: PostgresColumnType.TEXT,
    nativeColumnType: 'blob',
    isReadOnly: true,
  }),
  location: annotatedMySqlColumnSchema({
    valueSchema: Type.String({ contentEncoding: 'base64' }),
    family: PostgresColumnType.TEXT,
    nativeColumnType: 'point',
    isReadOnly: true,
  }),
  amount_with_tax: annotatedMySqlColumnSchema({
    valueSchema: Type.String(),
    family: PostgresColumnType.NUMERIC_STRING,
    nativeColumnType: 'decimal(12,2)',
    isReadOnly: true,
  }),
});

describe('buildMySqlTableWriteProfile', () => {
  const dealsWriteProfile = buildMySqlTableWriteProfile(DEALS_TABLE_SPEC);
  const columnWriteProfile = (columnName: string) => dealsWriteProfile.columnWriteProfileByColumnName.get(columnName);

  it('reads the id column and its binding kind from the spec', () => {
    expect(dealsWriteProfile.primaryKeyColumnName).toBe('id');
    expect(dealsWriteProfile.primaryKeyBindingKind).toBe('integer');
  });

  it('derives binary and text id binding kinds from the id column native type', () => {
    const binaryIdSpec = buildTableSpecWithColumns('uuid_bytes', {
      uuid_bytes: annotatedMySqlColumnSchema({
        valueSchema: Type.String(),
        family: PostgresColumnType.TEXT,
        nativeColumnType: 'binary(16)',
        isReadOnly: true,
      }),
    });
    const textIdSpec = buildTableSpecWithColumns('code', {
      code: annotatedMySqlColumnSchema({
        valueSchema: Type.String(),
        family: PostgresColumnType.TEXT,
        nativeColumnType: 'varchar(20)',
      }),
    });
    expect(buildMySqlTableWriteProfile(binaryIdSpec).primaryKeyBindingKind).toBe('base64Binary');
    expect(buildMySqlTableWriteProfile(textIdSpec).primaryKeyBindingKind).toBe('text');
  });

  it('classifies temporal columns from the native type', () => {
    expect(columnWriteProfile('closes_on')?.temporalColumnType).toEqual({ temporalKind: 'date' });
    expect(columnWriteProfile('closed_at')?.temporalColumnType).toEqual({
      temporalKind: 'datetime',
      fractionalSecondsPrecision: 3,
    });
    expect(columnWriteProfile('synced_at')?.temporalColumnType).toEqual({
      temporalKind: 'timestamp',
      fractionalSecondsPrecision: 6,
    });
    expect(columnWriteProfile('call_time')?.temporalColumnType).toBeUndefined();
    expect(columnWriteProfile('title')?.temporalColumnType).toBeUndefined();
  });

  it('reads a TIME column precision from the native type (a bare `time` is precision 0), for TIME columns only', () => {
    expect(columnWriteProfile('call_time')?.timeColumnFractionalSecondsPrecision).toBe(0);
    expect(columnWriteProfile('call_duration_with_milliseconds')?.timeColumnFractionalSecondsPrecision).toBe(3);
    for (const columnName of ['title', 'closed_at', 'created_at', 'closes_on', 'fiscal_year']) {
      expect([columnName, columnWriteProfile(columnName)?.timeColumnFractionalSecondsPrecision]).toEqual([
        columnName,
        undefined,
      ]);
    }
  });

  it('pins a DATETIME / TIMESTAMP declared without a precision to precision 0 (MySQL rounds a longer fraction)', () => {
    expect(columnWriteProfile('created_at')?.temporalColumnType).toEqual({
      temporalKind: 'datetime',
      fractionalSecondsPrecision: 0,
    });
  });

  it('falls back to the schema format (through the nullable union) when the native type annotation is absent', () => {
    const unannotatedSpec = buildTableSpecWithColumns('id', {
      due_on: Type.Optional(Type.Union([Type.String({ format: 'date' }), Type.Null()])),
      happened_at: Type.Union([Type.String({ format: 'date-time' }), Type.Null()]),
      wall_clock_at: Type.String({ format: 'date-time-local' }),
      plain: Type.String(),
    });
    const unannotatedProfile = buildMySqlTableWriteProfile(unannotatedSpec);
    expect(unannotatedProfile.primaryKeyBindingKind).toBe('passthrough');
    expect(unannotatedProfile.columnWriteProfileByColumnName.get('due_on')?.temporalColumnType).toEqual({
      temporalKind: 'date',
    });
    expect(unannotatedProfile.columnWriteProfileByColumnName.get('happened_at')?.temporalColumnType).toEqual({
      temporalKind: 'timestamp',
      fractionalSecondsPrecision: undefined,
    });
    expect(unannotatedProfile.columnWriteProfileByColumnName.get('wall_clock_at')?.temporalColumnType).toEqual({
      temporalKind: 'datetime',
      fractionalSecondsPrecision: undefined,
    });
    expect(unannotatedProfile.columnWriteProfileByColumnName.get('plain')?.temporalColumnType).toBeUndefined();
    // A pulled TIME is plain text with no schema format: without the native annotation it is not recognised.
    expect(
      unannotatedProfile.columnWriteProfileByColumnName.get('plain')?.timeColumnFractionalSecondsPrecision,
    ).toBeUndefined();
  });

  it('marks JSON columns by family or by native type (a MariaDB JSON alias reports native `json`)', () => {
    const mariaDbAliasSpec = buildTableSpecWithColumns('id', {
      aliased_document: annotatedMySqlColumnSchema({
        valueSchema: Type.Unknown(),
        family: PostgresColumnType.TEXT,
        nativeColumnType: 'json',
      }),
      family_only_document: Type.Unknown({ [X_SCRATCH_CONNECTOR_DATA_TYPE]: PostgresColumnType.JSONB }),
    });
    const mariaDbAliasProfile = buildMySqlTableWriteProfile(mariaDbAliasSpec);
    expect(columnWriteProfile('meta')?.isJsonDocumentColumn).toBe(true);
    expect(mariaDbAliasProfile.columnWriteProfileByColumnName.get('aliased_document')?.isJsonDocumentColumn).toBe(true);
    expect(mariaDbAliasProfile.columnWriteProfileByColumnName.get('family_only_document')?.isJsonDocumentColumn).toBe(
      true,
    );
    expect(columnWriteProfile('notes')?.isJsonDocumentColumn).toBe(false);
  });

  it('flags empty-string-rejecting columns by family and by native TIME / YEAR / UUID types', () => {
    for (const columnName of [
      'amount',
      'probability',
      'meta',
      'closes_on',
      'closed_at',
      'call_time',
      'fiscal_year',
      'external_uuid',
    ]) {
      expect([columnName, columnWriteProfile(columnName)?.rejectsEmptyString]).toEqual([columnName, true]);
    }
    for (const columnName of ['title', 'notes', 'stage']) {
      expect([columnName, columnWriteProfile(columnName)?.rejectsEmptyString]).toEqual([columnName, false]);
    }
  });

  it('flags read-only columns whose pulled representation cannot be written back', () => {
    expect(columnWriteProfile('attachment')?.isPulledInNonWritableRepresentation).toBe(true);
    expect(columnWriteProfile('location')?.isPulledInNonWritableRepresentation).toBe(true);
    // Read-only for another reason (generated / auto-increment): sent anyway, MySQL's rejection is surfaced.
    expect(columnWriteProfile('amount_with_tax')?.isPulledInNonWritableRepresentation).toBe(false);
    expect(columnWriteProfile('id')?.isPulledInNonWritableRepresentation).toBe(false);
    expect(columnWriteProfile('title')?.isPulledInNonWritableRepresentation).toBe(false);
  });

  it('does not flag a binary column that is somehow not read-only (both conditions are required)', () => {
    const writableBlobSpec = buildTableSpecWithColumns('id', {
      payload: annotatedMySqlColumnSchema({
        valueSchema: Type.String(),
        family: PostgresColumnType.TEXT,
        nativeColumnType: 'blob',
      }),
    });
    expect(
      buildMySqlTableWriteProfile(writableBlobSpec).columnWriteProfileByColumnName.get('payload')
        ?.isPulledInNonWritableRepresentation,
    ).toBe(false);
  });
});

describe('mysqlNativeColumnTypeRejectsEmptyString', () => {
  it.each([
    ['time', true],
    ['time(3)', true],
    ['year', true],
    ['uuid', true],
    ['inet4', true],
    ['inet6', true],
    ['varchar(10)', false],
    ["enum('a','')", false],
    ["set('a','b')", false],
  ])('%s → %s', (columnTypeSpelling, expectedRejectsEmptyString) => {
    expect(mysqlNativeColumnTypeRejectsEmptyString(columnTypeSpelling)).toBe(expectedRejectsEmptyString);
  });
});

describe('prepareRecordsForMySqlWrite', () => {
  const dealsWriteProfile: MySqlTableWriteProfile = buildMySqlTableWriteProfile(DEALS_TABLE_SPEC);
  const prepareOneDeal = (record: Record<string, unknown>) =>
    prepareRecordsForMySqlWrite([record], dealsWriteProfile)[0];

  function captureThrownError(action: () => unknown): unknown {
    try {
      action();
    } catch (error) {
      return error;
    }
    throw new Error('expected the action to throw');
  }

  it('drops undefined values', () => {
    expect(prepareOneDeal({ title: 'Deal', notes: undefined })).toEqual({ title: 'Deal' });
  });

  it("writes '' as NULL for columns that can never store an empty string, including TIME / YEAR / UUID", () => {
    expect(
      prepareOneDeal({
        amount: '',
        probability: '',
        meta: '',
        closes_on: '',
        closed_at: '',
        call_time: '',
        fiscal_year: '',
        external_uuid: '',
      }),
    ).toEqual({
      amount: null,
      probability: null,
      meta: null,
      closes_on: null,
      closed_at: null,
      call_time: null,
      fiscal_year: null,
      external_uuid: null,
    });
  });

  it("keeps '' verbatim in text, enum and unknown columns", () => {
    expect(prepareOneDeal({ title: '', notes: '', stage: '', not_in_spec: '' })).toEqual({
      title: '',
      notes: '',
      stage: '',
      not_in_spec: '',
    });
  });

  it('JSON-stringifies every non-null JSON value, including string scalars, numbers and booleans', () => {
    expect(prepareOneDeal({ meta: { nested: { a: 1 }, tags: ['x'] } }).meta).toBe('{"nested":{"a":1},"tags":["x"]}');
    expect(prepareOneDeal({ meta: ['a', 2] }).meta).toBe('["a",2]');
    expect(prepareOneDeal({ meta: 'just text' }).meta).toBe('"just text"');
    expect(prepareOneDeal({ meta: 42 }).meta).toBe('42');
    expect(prepareOneDeal({ meta: false }).meta).toBe('false');
    expect(prepareOneDeal({ meta: null }).meta).toBeNull();
  });

  it('JSON-stringifies objects and arrays bound for non-JSON columns (never `[object Object]` / comma lists)', () => {
    expect(prepareOneDeal({ notes: { a: 1 }, title: ['x', 'y'], not_in_spec: { b: 2 } })).toEqual({
      notes: '{"a":1}',
      title: '["x","y"]',
      not_in_spec: '{"b":2}',
    });
  });

  it('passes strings, numbers and booleans through for plain columns', () => {
    expect(prepareOneDeal({ title: 'Deal', probability: 40, is_hot: true, amount: '12.50' })).toEqual({
      title: 'Deal',
      probability: 40,
      is_hot: true,
      amount: '12.50',
    });
  });

  it('converts temporal text to the literal MySQL stores (offsets → UTC, fraction truncated to the precision)', () => {
    expect(
      prepareOneDeal({
        closes_on: '2026-03-05T00:00:00+05:00',
        closed_at: '2026-03-05T14:30:00.123456-05:00',
        created_at: '2026-03-05T14:30:05.678Z',
        synced_at: '2026-12-31T23:30:00.1234567+01:00',
      }),
    ).toEqual({
      closes_on: '2026-03-05',
      closed_at: '2026-03-05 19:30:00.123',
      created_at: '2026-03-05 14:30:05',
      synced_at: '2026-12-31 22:30:00.123456',
    });
  });

  it("converts recognised TIME text to the literal MySQL stores (seconds added, fraction truncated to the column's precision)", () => {
    expect(
      prepareOneDeal({
        call_time: '14:30:00.999',
        call_duration_with_milliseconds: '14:30:00.5',
      }),
    ).toEqual({
      call_time: '14:30:00',
      call_duration_with_milliseconds: '14:30:00.500',
    });
    expect(prepareOneDeal({ call_time: '9:05', call_duration_with_milliseconds: '-01:00' })).toEqual({
      call_time: '09:05:00',
      call_duration_with_milliseconds: '-01:00:00.000',
    });
    expect(prepareOneDeal({ call_time: '-00:00:00.5' })).toEqual({ call_time: '00:00:00' });
  });

  it('sends TIME values it does not recognise unchanged, so MySQL decides (no InvalidTemporalValue for TIME)', () => {
    expect(
      prepareOneDeal({
        call_time: '1 12:00:00',
        call_duration_with_milliseconds: '143000',
      }),
    ).toEqual({ call_time: '1 12:00:00', call_duration_with_milliseconds: '143000' });
    expect(prepareOneDeal({ call_time: '839:00:00' })).toEqual({ call_time: '839:00:00' });
    expect(prepareOneDeal({ call_time: 143000 })).toEqual({ call_time: 143000 });
    expect(prepareOneDeal({ call_time: null, call_duration_with_milliseconds: '' })).toEqual({
      call_time: null,
      call_duration_with_milliseconds: null,
    });
  });

  it('keeps NULL temporal values', () => {
    expect(prepareOneDeal({ closed_at: null, closes_on: null })).toEqual({ closed_at: null, closes_on: null });
  });

  it('fails with InvalidTemporalValue naming the column when the converter rejects the text', () => {
    const thrownError = captureThrownError(() => prepareOneDeal({ closes_on: '2026-03-05T14:30:00Z' }));
    expect(thrownError).toBeInstanceOf(MySqlClientError);
    expect(thrownError).toMatchObject({
      problem: MySqlClientProblem.InvalidTemporalValue,
      userFriendlyMessage:
        'Column "closes_on": "2026-03-05T14:30:00Z" includes a time of day, but this is a DATE column. Send a calendar date (YYYY-MM-DD), or change the column to DATETIME.',
    });
    expect(captureThrownError(() => prepareOneDeal({ closed_at: 'next tuesday' }))).toMatchObject({
      problem: MySqlClientProblem.InvalidTemporalValue,
    });
  });

  it.each([
    [20260305, 'a number'],
    [true, 'a true/false value'],
    [{ date: '2026-03-05' }, 'an object'],
    [['2026-03-05'], 'a list'],
  ])('fails with NonStringTemporalValue for %j (MySQL would read numbers as YYYYMMDD)', (value, valueKind) => {
    const thrownError = captureThrownError(() => prepareOneDeal({ closed_at: value }));
    expect(thrownError).toBeInstanceOf(MySqlClientError);
    expect(thrownError).toMatchObject({
      problem: MySqlClientProblem.NonStringTemporalValue,
      userFriendlyMessage: `Column "closed_at" is a DATETIME column, but the value is ${valueKind}, not text. Send the date and time as text, e.g. "2026-03-05 14:30:00".`,
    });
  });

  it('fails with NonWritableFieldEditError naming every non-writable column edited anywhere in the batch', () => {
    const thrownError = captureThrownError(() =>
      prepareRecordsForMySqlWrite(
        [{ title: 'a', attachment: 'AAEC' }, { location: 'AQID' }, { attachment: 'BBBB' }],
        dealsWriteProfile,
      ),
    );
    expect(thrownError).toBeInstanceOf(NonWritableFieldEditError);
    expect((thrownError as NonWritableFieldEditError).userFriendlyMessage).toBe(
      nonWritableFieldEditErrorMessage({ [NonWritableFieldReason.NotYetSupported]: ['attachment', 'location'] }),
    );
  });

  it('reports a non-writable edit before any temporal error in the same batch', () => {
    expect(
      captureThrownError(() =>
        prepareRecordsForMySqlWrite([{ closed_at: 'garbage' }, { attachment: 'AAEC' }], dealsWriteProfile),
      ),
    ).toBeInstanceOf(NonWritableFieldEditError);
  });

  it('lets NULL / absent values of non-writable columns through (clearing is not an edit of the bytes)', () => {
    expect(prepareOneDeal({ attachment: null, location: undefined, title: 'x' })).toEqual({
      attachment: null,
      title: 'x',
    });
  });

  it('does not pre-check generated / auto-increment columns: they are sent and MySQL rejects them', () => {
    expect(prepareOneDeal({ amount_with_tax: '99.00' })).toEqual({ amount_with_tax: '99.00' });
  });

  it('exempts the primary key from the non-writable check (it addresses the row, it is never written)', () => {
    const binaryIdProfile = buildMySqlTableWriteProfile(
      buildTableSpecWithColumns('uuid_bytes', {
        uuid_bytes: annotatedMySqlColumnSchema({
          valueSchema: Type.String(),
          family: PostgresColumnType.TEXT,
          nativeColumnType: 'binary(16)',
          isReadOnly: true,
        }),
        name: annotatedMySqlColumnSchema({
          valueSchema: Type.String(),
          family: PostgresColumnType.TEXT,
          nativeColumnType: 'varchar(10)',
        }),
      }),
    );
    expect(
      prepareRecordsForMySqlWrite([{ uuid_bytes: 'ABEiM0RVZneImaq7zN3u/w==', name: 'n' }], binaryIdProfile),
    ).toEqual([{ uuid_bytes: 'ABEiM0RVZneImaq7zN3u/w==', name: 'n' }]);
  });

  it('returns new objects in input order and never mutates the input records', () => {
    const inputRecords = [
      { title: 'first', meta: { a: 1 }, closed_at: '2026-03-05T14:30:00Z', amount: '' },
      { title: 'second' },
    ];
    const inputRecordsSnapshot = structuredClone(inputRecords);
    const preparedRecords = prepareRecordsForMySqlWrite(inputRecords, dealsWriteProfile);
    expect(inputRecords).toEqual(inputRecordsSnapshot);
    expect(preparedRecords).toHaveLength(2);
    expect(preparedRecords[0]).not.toBe(inputRecords[0]);
    expect(preparedRecords[1]).not.toBe(inputRecords[1]);
    expect(preparedRecords[1]).toEqual({ title: 'second' });
  });
});

describe('buildMySqlUpdateChangeSetWithWholeTopLevelValues', () => {
  it('writes the WHOLE top-level value of a sparsely-changed JSON column (no sparse-JSON clobber)', () => {
    const file = { id: '7', title: 'Deal', meta: { a: 2, b: 1, nested: { keep: true } } };
    const changeSet = buildMySqlUpdateChangeSetWithWholeTopLevelValues(file, { meta: { a: 2 } }, 'id');
    expect(changeSet).toEqual({ meta: { a: 2, b: 1, nested: { keep: true } } });
    expect(prepareRecordsForMySqlWrite([changeSet], buildMySqlTableWriteProfile(DEALS_TABLE_SPEC))[0]).toEqual({
      meta: '{"a":2,"b":1,"nested":{"keep":true}}',
    });
  });

  it('uses every key of the file (minus the id) when there is no sparse change set', () => {
    expect(
      buildMySqlUpdateChangeSetWithWholeTopLevelValues({ id: 7, title: 'Deal', amount: null }, undefined, 'id'),
    ).toEqual({ title: 'Deal', amount: null });
  });

  it('never includes the primary key, even when the change set names it', () => {
    expect(
      buildMySqlUpdateChangeSetWithWholeTopLevelValues({ id: 8, title: 'Deal' }, { id: 8, title: 'Deal' }, 'id'),
    ).toEqual({ title: 'Deal' });
  });

  it('keeps the changed value of a key the file lacks instead of dropping the edit', () => {
    expect(buildMySqlUpdateChangeSetWithWholeTopLevelValues({ id: 1 }, { title: 'New' }, 'id')).toEqual({
      title: 'New',
    });
  });

  it('returns a new object and never mutates its inputs', () => {
    const file = { id: 1, meta: { a: 1, b: 2 } };
    const sparseChangedFields = { meta: { a: 1 } };
    const fileSnapshot = structuredClone(file);
    const sparseChangedFieldsSnapshot = structuredClone(sparseChangedFields);
    buildMySqlUpdateChangeSetWithWholeTopLevelValues(file, sparseChangedFields, 'id');
    expect(file).toEqual(fileSnapshot);
    expect(sparseChangedFields).toEqual(sparseChangedFieldsSnapshot);
  });
});
