import {
  decodeMySqlBitFieldValue,
  decodeMySqlColumnValue,
  type MySqlTypeCastField,
  parseMySqlJsonDocumentText,
} from '../mysql-row-value-decoder';

interface FakeTypeCastColumnOptions {
  type: MySqlTypeCastField['type'];
  /** The column's bytes on the wire; null for SQL NULL. */
  wireBytes: Buffer | null;
  /** What mysql2's default decoding (`next()`) would return for this column. */
  defaultDecodedValue?: unknown;
  length?: number;
  db?: string;
  extendedFormat?: string;
}

/**
 * A fake mysql2 typeCast field whose three read paths (`string`, `buffer`, `next`) share one counter: the decoder
 * must read every field exactly once, or it would consume the next column's bytes.
 */
function createFakeTypeCastColumn(options: FakeTypeCastColumnOptions) {
  let readCount = 0;
  const readAsString = jest.fn((encoding?: string) => {
    readCount += 1;
    return options.wireBytes === null ? null : options.wireBytes.toString((encoding ?? 'binary') as BufferEncoding);
  });
  const readAsBuffer = jest.fn(() => {
    readCount += 1;
    return options.wireBytes;
  });
  const readDefaultValue = jest.fn(() => {
    readCount += 1;
    return options.defaultDecodedValue;
  });
  const field: MySqlTypeCastField = {
    type: options.type,
    length: options.length ?? 0,
    db: options.db ?? 'shop',
    name: 'column_under_test',
    extendedFormat: options.extendedFormat,
    string: readAsString,
    buffer: readAsBuffer,
  };
  return { field, readAsString, readAsBuffer, readDefaultValue, readCount: () => readCount };
}

function decodeFakeColumn(options: FakeTypeCastColumnOptions) {
  const fakeColumn = createFakeTypeCastColumn(options);
  const decodedValue = decodeMySqlColumnValue(fakeColumn.field, fakeColumn.readDefaultValue);
  expect(fakeColumn.readCount()).toBe(1);
  return { decodedValue, ...fakeColumn };
}

describe('decodeMySqlColumnValue', () => {
  describe('TIMESTAMP', () => {
    it.each([
      ['2026-07-23 16:12:27', '2026-07-23T16:12:27Z'],
      ['2026-07-23 16:12:27.123', '2026-07-23T16:12:27.123Z'],
      ['2026-07-23 16:12:27.123456', '2026-07-23T16:12:27.123456Z'],
    ])('rewrites %j as RFC 3339 UTC %j', (timestampText, expectedRfc3339Text) => {
      const { decodedValue, readAsString, readDefaultValue } = decodeFakeColumn({
        type: 'TIMESTAMP',
        wireBytes: Buffer.from(timestampText, 'ascii'),
      });
      expect(decodedValue).toBe(expectedRfc3339Text);
      expect(readAsString).toHaveBeenCalledWith('ascii');
      expect(readDefaultValue).not.toHaveBeenCalled();
    });

    it('handles TIMESTAMP2 the same way', () => {
      expect(decodeFakeColumn({ type: 'TIMESTAMP2', wireBytes: Buffer.from('2026-01-02 03:04:05') }).decodedValue).toBe(
        '2026-01-02T03:04:05Z',
      );
    });

    it('keeps a zero date verbatim', () => {
      expect(decodeFakeColumn({ type: 'TIMESTAMP', wireBytes: Buffer.from('0000-00-00 00:00:00') }).decodedValue).toBe(
        '0000-00-00 00:00:00',
      );
    });

    it('passes NULL through', () => {
      expect(decodeFakeColumn({ type: 'TIMESTAMP', wireBytes: null }).decodedValue).toBeNull();
    });
  });

  describe('DATE and DATETIME', () => {
    it.each<[MySqlTypeCastField['type'], string]>([
      ['DATETIME', '2026-07-23 16:12:27.123456'],
      ['DATETIME2', '2026-07-23 16:12:27'],
      ['DATE', '2026-07-23'],
      ['NEWDATE', '2026-07-23'],
      ['DATE', '0000-00-00'],
      ['DATETIME', '0000-00-00 00:00:00'],
    ])('keeps %s %j verbatim without calling next()', (type, temporalText) => {
      const { decodedValue, readDefaultValue } = decodeFakeColumn({ type, wireBytes: Buffer.from(temporalText) });
      expect(decodedValue).toBe(temporalText);
      expect(readDefaultValue).not.toHaveBeenCalled();
    });
  });

  describe('JSON', () => {
    it("parses the document from the raw text read as 'utf8' (JSON columns are charset 63)", () => {
      const jsonDocumentText = '{"emoji":"🚀","name":"Zoë","nested":{"list":[1,2]}}';
      const { decodedValue, readAsString, readDefaultValue } = decodeFakeColumn({
        type: 'JSON',
        wireBytes: Buffer.from(jsonDocumentText, 'utf8'),
      });
      expect(readAsString).toHaveBeenCalledWith('utf8');
      expect(decodedValue).toEqual({ emoji: '🚀', name: 'Zoë', nested: { list: [1, 2] } });
      expect(readDefaultValue).not.toHaveBeenCalled();
    });

    it('parses scalar documents', () => {
      expect(decodeFakeColumn({ type: 'JSON', wireBytes: Buffer.from('"text"') }).decodedValue).toBe('text');
      expect(decodeFakeColumn({ type: 'JSON', wireBytes: Buffer.from('12.5') }).decodedValue).toBe(12.5);
    });

    it('loses precision above 2^53 exactly like JSON.parse (Postgres parity)', () => {
      expect(decodeFakeColumn({ type: 'JSON', wireBytes: Buffer.from('{"n":9007199254740993}') }).decodedValue).toEqual(
        { n: 9007199254740992 },
      );
    });

    it('returns the raw text when the document is not valid JSON, instead of throwing inside the row parser', () => {
      expect(decodeFakeColumn({ type: 'JSON', wireBytes: Buffer.from('{"a":') }).decodedValue).toBe('{"a":');
    });

    it('passes NULL through', () => {
      expect(decodeFakeColumn({ type: 'JSON', wireBytes: null }).decodedValue).toBeNull();
    });

    it("parses MariaDB's JSON alias (a text column flagged extendedFormat 'json')", () => {
      const { decodedValue, readAsString, readDefaultValue } = decodeFakeColumn({
        type: 'BLOB',
        extendedFormat: 'json',
        wireBytes: Buffer.from('{"big":9007199254740993,"emoji":"🚀"}', 'utf8'),
      });
      expect(readAsString).toHaveBeenCalledWith('utf8');
      expect(decodedValue).toEqual({ big: 9007199254740992, emoji: '🚀' });
      expect(readDefaultValue).not.toHaveBeenCalled();
    });
  });

  describe('BIT', () => {
    it.each<[number, number[], number | string]>([
      [1, [0x01], 1],
      [1, [0x00], 0],
      [8, [0xa5], 165],
      [16, [0x01, 0x00], 256],
      [53, [0x1f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], Number.MAX_SAFE_INTEGER],
      [54, [0x3f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], '18014398509481983'],
      [64, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], '18446744073709551615'],
    ])('BIT(%i) %j → %p', (bitWidth, bitFieldBytes, expectedValue) => {
      const { decodedValue, readAsBuffer } = decodeFakeColumn({
        type: 'BIT',
        length: bitWidth,
        wireBytes: Buffer.from(bitFieldBytes),
      });
      expect(decodedValue).toBe(expectedValue);
      expect(readAsBuffer).toHaveBeenCalledTimes(1);
    });

    it('passes NULL through', () => {
      expect(decodeFakeColumn({ type: 'BIT', length: 1, wireBytes: null }).decodedValue).toBeNull();
    });
  });

  describe('GEOMETRY', () => {
    it('base64-encodes the exact bytes, keeping the 4-byte SRID prefix', () => {
      const pointWithSrid4326 = Buffer.from('e6100000010100000000000000000024400000000000003440', 'hex');
      const { decodedValue, readDefaultValue } = decodeFakeColumn({ type: 'GEOMETRY', wireBytes: pointWithSrid4326 });
      expect(decodedValue).toBe(pointWithSrid4326.toString('base64'));
      expect(
        Buffer.from(decodedValue as string, 'base64')
          .subarray(0, 4)
          .toString('hex'),
      ).toBe('e6100000');
      expect(readDefaultValue).not.toHaveBeenCalled();
    });

    it('passes NULL through', () => {
      expect(decodeFakeColumn({ type: 'GEOMETRY', wireBytes: null }).decodedValue).toBeNull();
    });
  });

  describe("mysql2's default decoding", () => {
    it('base64-encodes binary values (BLOB / BINARY / VARBINARY arrive as Buffers)', () => {
      const binaryBytes = Buffer.from([0x00, 0xff, 0x10, 0x80]);
      const { decodedValue, readDefaultValue } = decodeFakeColumn({
        type: 'BLOB',
        wireBytes: binaryBytes,
        defaultDecodedValue: binaryBytes,
      });
      expect(decodedValue).toBe(binaryBytes.toString('base64'));
      expect(readDefaultValue).toHaveBeenCalledTimes(1);
    });

    it.each<[MySqlTypeCastField['type'], unknown]>([
      ['VAR_STRING', 'plain text'],
      ['BLOB', 'long text column'],
      ['STRING', 'enum member'],
      ['LONGLONG', '9007199254740993'],
      ['NEWDECIMAL', '12.50'],
      ['LONG', 42],
      ['TINY', 1],
      ['DOUBLE', 1.5],
      ['TIME', '838:59:59'],
      ['VECTOR', [0.5, 1.5]],
      ['VAR_STRING', null],
    ])('returns a %s value %p unchanged', (type, defaultDecodedValue) => {
      const { decodedValue, readAsString, readAsBuffer } = decodeFakeColumn({
        type,
        wireBytes: Buffer.from('ignored'),
        defaultDecodedValue,
      });
      expect(decodedValue).toEqual(defaultDecodedValue);
      expect(readAsString).not.toHaveBeenCalled();
      expect(readAsBuffer).not.toHaveBeenCalled();
    });
  });

  describe('information_schema columns', () => {
    it('decode catalog bytes as utf8 text, never base64', () => {
      const { decodedValue } = decodeFakeColumn({
        type: 'BLOB',
        db: 'information_schema',
        wireBytes: Buffer.from("enum('a','b')"),
        defaultDecodedValue: Buffer.from("enum('a','b')", 'utf8'),
      });
      expect(decodedValue).toBe("enum('a','b')");
    });

    it('match the database name case-insensitively', () => {
      expect(
        decodeFakeColumn({
          type: 'VAR_STRING',
          db: 'INFORMATION_SCHEMA',
          wireBytes: Buffer.from('x'),
          defaultDecodedValue: Buffer.from('InnoDB'),
        }).decodedValue,
      ).toBe('InnoDB');
    });

    it('bypass the temporal rewrite', () => {
      const { decodedValue, readAsString } = decodeFakeColumn({
        type: 'TIMESTAMP',
        db: 'information_schema',
        wireBytes: Buffer.from('2026-01-02 03:04:05'),
        defaultDecodedValue: '2026-01-02 03:04:05',
      });
      expect(decodedValue).toBe('2026-01-02 03:04:05');
      expect(readAsString).not.toHaveBeenCalled();
    });

    it('keep non-buffer catalog values as mysql2 decoded them', () => {
      expect(
        decodeFakeColumn({
          type: 'LONGLONG',
          db: 'information_schema',
          wireBytes: Buffer.from('255'),
          defaultDecodedValue: '255',
        }).decodedValue,
      ).toBe('255');
    });
  });
});

describe('parseMySqlJsonDocumentText', () => {
  it('parses valid JSON, keeps invalid text, and passes NULL through', () => {
    expect(parseMySqlJsonDocumentText('[1,"a",null]')).toEqual([1, 'a', null]);
    expect(parseMySqlJsonDocumentText('not json')).toBe('not json');
    expect(parseMySqlJsonDocumentText(null)).toBeNull();
  });
});

describe('decodeMySqlBitFieldValue', () => {
  it('returns a number up to 53 bits and an exact decimal string above', () => {
    expect(decodeMySqlBitFieldValue(Buffer.from([0x01]), 1)).toBe(1);
    expect(decodeMySqlBitFieldValue(Buffer.from([0x00, 0x00]), 64)).toBe('0');
    expect(decodeMySqlBitFieldValue(null, 8)).toBeNull();
  });
});
