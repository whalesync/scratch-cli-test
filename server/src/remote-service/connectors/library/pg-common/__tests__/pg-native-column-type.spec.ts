import type { InformationSchemaColumn } from '../knex-pg-types';
import {
  isRecreatablePostgresNativeColumnType,
  POSTGRES_NATIVE_TYPE_SYSTEM,
  postgresNativeColumnTypeAnnotation,
} from '../pg-native-column-type';

function column(overrides: Partial<InformationSchemaColumn>): InformationSchemaColumn {
  return {
    column_name: 'value',
    data_type: 'text',
    column_default: null,
    is_updatable: 'YES',
    is_nullable: 'YES',
    domain_name: null,
    udt_name: 'text',
    character_maximum_length: null,
    is_identity: 'NO',
    identity_increment: null,
    identity_cycle: 'NO',
    ...overrides,
  };
}

describe('isRecreatablePostgresNativeColumnType', () => {
  it.each([
    'text',
    'text[]',
    'character varying(50)',
    'character varying(50)[]',
    'character(10)',
    'uuid',
    'uuid[]',
    'smallint',
    'integer',
    'integer[]',
    'bigint',
    'bigint[]',
    'numeric',
    'numeric(10,2)',
    'numeric(10,2)[]',
    'real',
    'double precision',
    'double precision[]',
    'boolean',
    'boolean[]',
    'date',
    'date[]',
    'timestamp without time zone',
    'timestamp with time zone',
    'timestamp(3) with time zone',
    'timestamp with time zone[]',
    'time without time zone',
    'time(6) with time zone',
    'json',
    'jsonb',
  ])('recreates %s', (nativeType) => {
    expect(isRecreatablePostgresNativeColumnType(nativeType)).toBe(true);
  });

  it.each([
    // Pulled value doesn't write back as-is.
    'bytea',
    'interval',
    'point',
    // JSON arrays don't bind through a pg array literal.
    'json[]',
    'jsonb[]',
    // User-defined / extension types may not exist in the destination database.
    'public.mood',
    'mood',
    'citext',
    'vector(3)',
    // Quoted / malformed / injection attempts never reach DDL.
    '"char"',
    'text); drop table users; --',
    'text[][]',
    'Integer',
    'numeric(10,2,3)',
    '',
  ])('does not recreate %s', (nativeType) => {
    expect(isRecreatablePostgresNativeColumnType(nativeType)).toBe(false);
  });
});

describe('postgresNativeColumnTypeAnnotation', () => {
  it('annotates a built-in recreatable type', () => {
    expect(
      postgresNativeColumnTypeAnnotation(column({ native_type: 'text[]', native_type_is_built_in: true })),
    ).toEqual({ typeSystem: POSTGRES_NATIVE_TYPE_SYSTEM, type: 'text[]', isRecreatableVerbatim: true });
  });

  it('annotates but does not recreate a built-in whose pulled value does not round-trip', () => {
    expect(postgresNativeColumnTypeAnnotation(column({ native_type: 'bytea', native_type_is_built_in: true }))).toEqual(
      {
        typeSystem: POSTGRES_NATIVE_TYPE_SYSTEM,
        type: 'bytea',
        isRecreatableVerbatim: false,
      },
    );
  });

  it('does not recreate a user-defined type even when its name looks built-in', () => {
    expect(
      postgresNativeColumnTypeAnnotation(column({ native_type: 'text', native_type_is_built_in: false }))
        ?.isRecreatableVerbatim,
    ).toBe(false);
  });

  it('omits the annotation when the catalog reported no native type', () => {
    expect(postgresNativeColumnTypeAnnotation(column({}))).toBeUndefined();
    expect(postgresNativeColumnTypeAnnotation(column({ native_type: null }))).toBeUndefined();
  });
});
