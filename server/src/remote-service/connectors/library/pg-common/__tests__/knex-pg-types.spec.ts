/**
 * Unit tests for chooseUniquelyAddressableColumn (DEV-10802 / DEV-10821): the
 * single shared choice of which column a table's records are addressed by
 * (`idPath`) and which column a foreign key into the table references. The
 * inputs mirror what KnexPGClient.findSingleColumnUniqueIndexColumns returns —
 * only genuinely unique single columns, with `format_type` native types.
 */
import {
  chooseUniquelyAddressableColumn,
  type InformationSchemaColumn,
  type SingleColumnUniqueIndexColumn,
} from '../knex-pg-types';

function buildInformationSchemaColumn(
  overrides: Partial<InformationSchemaColumn> & { column_name: string },
): InformationSchemaColumn {
  return {
    data_type: 'text',
    column_default: null,
    is_updatable: 'YES',
    is_nullable: 'NO',
    domain_name: null,
    udt_name: 'text',
    character_maximum_length: null,
    is_identity: 'NO',
    identity_increment: null,
    identity_cycle: 'NO',
    ...overrides,
  };
}

function buildUniqueColumn(
  overrides: Partial<SingleColumnUniqueIndexColumn> & { column_name: string },
): SingleColumnUniqueIndexColumn {
  return { native_type: 'text', is_primary_key: false, ...overrides };
}

describe('chooseUniquelyAddressableColumn', () => {
  it('returns null when the table has no single-column unique index (e.g. only a composite primary key)', () => {
    const chosen = chooseUniquelyAddressableColumn(
      [],
      [
        buildInformationSchemaColumn({ column_name: 'order_id' }),
        buildInformationSchemaColumn({ column_name: 'product_id' }),
      ],
    );
    expect(chosen).toBeNull();
  });

  it('prefers the single-column primary key, carrying its exact native type', () => {
    const chosen = chooseUniquelyAddressableColumn(
      [
        buildUniqueColumn({ column_name: 'email', native_type: 'citext' }),
        buildUniqueColumn({ column_name: 'id', native_type: 'uuid', is_primary_key: true }),
      ],
      [buildInformationSchemaColumn({ column_name: 'id' }), buildInformationSchemaColumn({ column_name: 'email' })],
    );
    expect(chosen).toEqual({ column: 'id', nativeType: 'uuid' });
  });

  it('falls back to an auto-generated unique column when the primary key is composite (absent from the unique list)', () => {
    const chosen = chooseUniquelyAddressableColumn(
      [
        buildUniqueColumn({ column_name: 'slug', native_type: 'text' }),
        buildUniqueColumn({ column_name: 'row_uuid', native_type: 'uuid' }),
      ],
      [
        buildInformationSchemaColumn({ column_name: 'slug' }),
        buildInformationSchemaColumn({ column_name: 'row_uuid', column_default: 'gen_random_uuid()' }),
      ],
    );
    expect(chosen).toEqual({ column: 'row_uuid', nativeType: 'uuid' });
  });

  it('falls back to the first unique column when none is auto-generated', () => {
    const chosen = chooseUniquelyAddressableColumn(
      [
        buildUniqueColumn({ column_name: 'email', native_type: 'citext' }),
        buildUniqueColumn({ column_name: 'slug', native_type: 'text' }),
      ],
      [buildInformationSchemaColumn({ column_name: 'email' }), buildInformationSchemaColumn({ column_name: 'slug' })],
    );
    expect(chosen).toEqual({ column: 'email', nativeType: 'citext' });
  });

  it('preserves exotic primary-key native types verbatim (enum / array — the DEV-10821 DDL inputs)', () => {
    const enumPkChoice = chooseUniquelyAddressableColumn(
      [buildUniqueColumn({ column_name: 'status', native_type: 'app.order_status', is_primary_key: true })],
      [buildInformationSchemaColumn({ column_name: 'status', data_type: 'USER-DEFINED', udt_name: 'order_status' })],
    );
    expect(enumPkChoice).toEqual({ column: 'status', nativeType: 'app.order_status' });

    const arrayPkChoice = chooseUniquelyAddressableColumn(
      [buildUniqueColumn({ column_name: 'path', native_type: 'integer[]', is_primary_key: true })],
      [buildInformationSchemaColumn({ column_name: 'path', data_type: 'ARRAY', udt_name: '_int4' })],
    );
    expect(arrayPkChoice).toEqual({ column: 'path', nativeType: 'integer[]' });
  });
});
