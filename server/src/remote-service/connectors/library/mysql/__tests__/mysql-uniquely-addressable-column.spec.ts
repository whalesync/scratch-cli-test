import { type MySqlSingleColumnUniqueIndexColumn } from '../mysql-catalog-types';
import { chooseMySqlUniquelyAddressableColumn } from '../mysql-uniquely-addressable-column';

function uniqueIndexColumn(
  columnName: string,
  ordinalPosition: number,
  flags: Partial<
    Pick<MySqlSingleColumnUniqueIndexColumn, 'isPrimaryKey' | 'isNullable' | 'isAutoIncrement' | 'nativeType'>
  > = {},
): MySqlSingleColumnUniqueIndexColumn {
  return {
    indexName: flags.isPrimaryKey ? 'PRIMARY' : `${columnName}_unique`,
    columnName,
    nativeType: 'int',
    isPrimaryKey: false,
    isNullable: false,
    isAutoIncrement: false,
    ordinalPosition,
    ...flags,
  };
}

describe('chooseMySqlUniquelyAddressableColumn', () => {
  it('prefers the single-column primary key over every other unique column', () => {
    const chosenColumn = chooseMySqlUniquelyAddressableColumn([
      uniqueIndexColumn('external_id', 1, { isAutoIncrement: true }),
      uniqueIndexColumn('code', 2),
      uniqueIndexColumn('uuid_key', 3, { isPrimaryKey: true }),
    ]);
    expect(chosenColumn?.columnName).toBe('uuid_key');
  });

  it('prefers an AUTO_INCREMENT unique column when there is no primary key', () => {
    const chosenColumn = chooseMySqlUniquelyAddressableColumn([
      uniqueIndexColumn('code', 1),
      uniqueIndexColumn('seq', 2, { isAutoIncrement: true }),
    ]);
    expect(chosenColumn?.columnName).toBe('seq');
  });

  it('prefers a NOT NULL unique column over a nullable one', () => {
    const chosenColumn = chooseMySqlUniquelyAddressableColumn([
      uniqueIndexColumn('email', 1, { isNullable: true }),
      uniqueIndexColumn('code', 2),
    ]);
    expect(chosenColumn?.columnName).toBe('code');
  });

  it('falls back to the first nullable unique column (Postgres parity)', () => {
    const chosenColumn = chooseMySqlUniquelyAddressableColumn([
      uniqueIndexColumn('handle', 3, { isNullable: true }),
      uniqueIndexColumn('email', 2, { isNullable: true }),
    ]);
    expect(chosenColumn?.columnName).toBe('email');
  });

  it('breaks ties by column position, not input order', () => {
    const chosenColumn = chooseMySqlUniquelyAddressableColumn([
      uniqueIndexColumn('later_code', 5),
      uniqueIndexColumn('earlier_code', 2),
    ]);
    expect(chosenColumn?.columnName).toBe('earlier_code');
  });

  it('returns null when no single-column unique index exists', () => {
    expect(chooseMySqlUniquelyAddressableColumn([])).toBeNull();
  });

  describe('columns whose pulled id cannot be bound back to their row', () => {
    it('skips a FLOAT primary key for the next unique column', () => {
      const chosenColumn = chooseMySqlUniquelyAddressableColumn([
        uniqueIndexColumn('measurement', 1, { isPrimaryKey: true, nativeType: 'float' }),
        uniqueIndexColumn('reading_code', 2, { nativeType: 'varchar(20)' }),
      ]);
      expect(chosenColumn?.columnName).toBe('reading_code');
    });

    it.each(['float', 'float(7,4) unsigned', 'blob', 'geometry', 'some_future_type'])(
      'returns null when the only unique column is %s (the spec then asks the user for an id)',
      (nativeType) => {
        expect(
          chooseMySqlUniquelyAddressableColumn([uniqueIndexColumn('k', 1, { isPrimaryKey: true, nativeType })]),
        ).toBeNull();
      },
    );

    it.each(['double', 'bit(8)', 'binary(16)', 'varbinary(32)', 'timestamp(3)', 'date', 'decimal(10,2)'])(
      'keeps a %s primary key (its pulled id binds back exactly)',
      (nativeType) => {
        expect(
          chooseMySqlUniquelyAddressableColumn([uniqueIndexColumn('k', 1, { isPrimaryKey: true, nativeType })])
            ?.columnName,
        ).toBe('k');
      },
    );
  });

  it('does not reorder the caller array', () => {
    const uniqueIndexColumns = [uniqueIndexColumn('b', 2), uniqueIndexColumn('a', 1)];
    chooseMySqlUniquelyAddressableColumn(uniqueIndexColumns);
    expect(uniqueIndexColumns.map((column) => column.columnName)).toEqual(['b', 'a']);
  });
});
