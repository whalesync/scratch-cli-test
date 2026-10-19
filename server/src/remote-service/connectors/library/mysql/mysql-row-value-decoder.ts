/**
 * The mysql2 `typeCast` hook: decides the on-disk JSON value of every column MySQL returns (text protocol).
 *
 * Connector Prime Directive: values stay as MySQL reported them unless JSON can't carry them as-is. Record the
 * rationale for each case in STATE.md:
 * - TIMESTAMP → RFC 3339 UTC text (see mysql-temporal-values.ts); DATE / DATETIME → MySQL's own text, verbatim.
 * - JSON → the parsed document. Parsed from the raw text (`field.string('utf8')`: JSON columns are charset 63, so
 *   the default decoding would mangle non-ASCII), not by mysql2, whose own parser turns integers above 2^53 into
 *   strings inside the document (≥3.23). Precision above 2^53 is lost exactly as in the Postgres connector.
 * - MariaDB's JSON alias (a LONGTEXT flagged `extendedFormat: 'json'`) → parsed the same way.
 * - BIT(n) → its unsigned integer value (a decimal string above 53 bits). BIT(1) is Hibernate's boolean mapping,
 *   so base64 (`'AQ=='`) would be unreadable.
 * - BLOB / BINARY / VARBINARY / GEOMETRY → base64 of the exact bytes (GEOMETRY keeps its 4-byte SRID prefix).
 *   JSON can't carry raw bytes; base64 is the lossless text form. These columns are read-only.
 * - everything else → mysql2's default (numbers; BIGINT/DECIMAL as strings via bigNumberStrings; text).
 *
 * Invariant: exactly ONE read per field. Calling `next()` after `field.string()` would consume the next column.
 */
import { type TypeCastField, type TypeCastNext } from 'mysql2';
import { renderMySqlTimestampTextAsRfc3339Utc } from './mysql-temporal-values';

/** The subset of mysql2's typeCast `Field` this decoder reads (a structural type, so tests can fake it). */
export type MySqlTypeCastField = Pick<
  TypeCastField,
  'type' | 'length' | 'db' | 'name' | 'extendedFormat' | 'string' | 'buffer'
>;

export function decodeMySqlColumnValue(field: MySqlTypeCastField, readDefaultValue: TypeCastNext): unknown {
  // Catalog reads (information_schema) keep mysql2's default decoding, but never as bytes.
  if (field.db.toLowerCase() === 'information_schema') {
    const catalogValue = readDefaultValue();
    return Buffer.isBuffer(catalogValue) ? catalogValue.toString('utf8') : catalogValue;
  }
  switch (field.type) {
    case 'TIMESTAMP':
    case 'TIMESTAMP2':
      return renderMySqlTimestampTextAsRfc3339Utc(field.string('ascii'));
    case 'DATETIME':
    case 'DATETIME2':
    case 'DATE':
    case 'NEWDATE':
      return field.string('ascii');
    case 'JSON':
      return parseMySqlJsonDocumentText(field.string('utf8'));
    case 'BIT':
      return decodeMySqlBitFieldValue(field.buffer(), field.length);
    case 'GEOMETRY':
      return encodeNullableBufferAsBase64(field.buffer());
    default:
      break;
  }
  if (field.extendedFormat === 'json') {
    return parseMySqlJsonDocumentText(field.string('utf8'));
  }
  const defaultValue: unknown = readDefaultValue();
  return Buffer.isBuffer(defaultValue) ? defaultValue.toString('base64') : defaultValue;
}

/** A JSON column's document; the raw text if it somehow isn't valid JSON (never throw inside the row parser). */
export function parseMySqlJsonDocumentText(jsonDocumentText: string | null): unknown {
  if (jsonDocumentText === null) return null;
  try {
    return JSON.parse(jsonDocumentText) as unknown;
  } catch {
    return jsonDocumentText;
  }
}

/** BIT(n) bytes (big-endian) → number when n ≤ 53, else the exact decimal string. */
export function decodeMySqlBitFieldValue(bitFieldBytes: Buffer | null, bitWidth: number): number | string | null {
  if (bitFieldBytes === null) return null;
  if (bitWidth <= 53) {
    return bitFieldBytes.reduce((accumulatedValue, byte) => accumulatedValue * 256 + byte, 0);
  }
  return bitFieldBytes.reduce((accumulatedValue, byte) => accumulatedValue * 256n + BigInt(byte), 0n).toString();
}

function encodeNullableBufferAsBase64(bytes: Buffer | null): string | null {
  return bytes === null ? null : bytes.toString('base64');
}
