import {
  buildMySqlTablePreviewWriteRestrictions,
  isStorageEngineSafeForScratchWrites,
  TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON,
  unsupportedStorageEngineMessage,
  unsupportedStorageEngineWriteMessage,
} from '../mysql-table-writability';

describe('isStorageEngineSafeForScratchWrites', () => {
  it.each(['InnoDB', 'innodb', 'INNODB'])('allows %s', (storageEngine) => {
    expect(isStorageEngineSafeForScratchWrites(storageEngine)).toBe(true);
  });

  it.each(['MyISAM', 'MEMORY', 'ARCHIVE', 'Aria', 'RocksDB', 'ndbcluster', '', null, undefined])(
    'refuses %p (no transactional rollback Scratch relies on)',
    (storageEngine) => {
      expect(isStorageEngineSafeForScratchWrites(storageEngine)).toBe(false);
    },
  );
});

describe('buildMySqlTablePreviewWriteRestrictions', () => {
  it('leaves an InnoDB table with an AUTO_INCREMENT id fully writable', () => {
    expect(
      buildMySqlTablePreviewWriteRestrictions({ storageEngine: 'InnoDB', hasAutoIncrementPrimaryKey: true }),
    ).toEqual({});
  });

  it('disables only creates when the id is not AUTO_INCREMENT', () => {
    expect(
      buildMySqlTablePreviewWriteRestrictions({ storageEngine: 'InnoDB', hasAutoIncrementPrimaryKey: false }),
    ).toEqual({ disabledCreates: true, disabledReason: TABLE_WITHOUT_AUTO_INCREMENT_ID_CREATES_DISABLED_REASON });
  });

  it('disables every write for a non-InnoDB engine, ahead of the AUTO_INCREMENT rule', () => {
    expect(
      buildMySqlTablePreviewWriteRestrictions({ storageEngine: 'MyISAM', hasAutoIncrementPrimaryKey: false }),
    ).toEqual({
      disabledCreates: true,
      disabledUpdates: true,
      disabledDeletes: true,
      disabledReason: unsupportedStorageEngineMessage('MyISAM'),
    });
  });

  it('treats an unknown engine as unsafe', () => {
    const writeRestrictions = buildMySqlTablePreviewWriteRestrictions({
      storageEngine: null,
      hasAutoIncrementPrimaryKey: true,
    });
    expect(writeRestrictions.disabledUpdates).toBe(true);
    expect(writeRestrictions.disabledReason).toContain('uses a storage engine,');
  });
});

describe('storage engine messages', () => {
  it('names the engine and the fix in the preview reason', () => {
    const previewReason = unsupportedStorageEngineMessage('MyISAM');
    expect(previewReason).toContain('the MyISAM storage engine');
    expect(previewReason).toContain('ENGINE=InnoDB');
  });

  it('names the table in the write-time message', () => {
    expect(unsupportedStorageEngineWriteMessage({ databaseName: 'shop', tableName: 'orders' }, 'MEMORY')).toContain(
      '"shop"."orders": it uses the MEMORY storage engine',
    );
  });
});
