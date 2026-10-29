/**
 * MySQL field-value canonicalizers (the DEV-10556 "diff transform" framework, see
 * `field-value-canonicalization.ts`): what makes a Live Export re-run into a MySQL destination a no-op.
 *
 * MySQL stores most values as sent, but re-renders several column types on read-back, so the value the sync wrote
 * and the value the next pull stores would never compare equal structurally — every run would re-publish every row.
 * Each canonicalizer reduces a value to what MySQL itself returns after the write, applying MySQL's own rounding
 * rules (each verified against MySQL 8.4 and MariaDB 11.4). Two deliberate differences, only ever LOSSIER than
 * MySQL: DOUBLE compares at 15 significant digits (Postgres parity), so two doubles that differ only beyond that
 * compare equal, and so do the numbers inside a JSON document that aren't safe integers (see JSON below). A value
 * shape a rule doesn't recognise passes through unchanged and compares structurally — at worst a needless re-publish.
 *
 * - DATE / DATETIME / TIMESTAMP / TIME: reduced to the literal the WRITE PATH sends
 *   (`convertTemporalValueToMySqlLiteral` / `convertRecognizedTimeTextToMySqlTimeLiteral`, shared with
 *   `mysql-record-preparation.ts`), so what Scratch writes and what it compares can never disagree:
 *   `2026-03-05T14:30:00-05:00` and the stored `2026-03-05 19:30:00.000` agree; a pulled TIMESTAMP
 *   (`…T19:30:00.000Z`) agrees too; TIME `14:30` and the stored `14:30:00` agree. A DATE / DATETIME / TIMESTAMP
 *   value the converter rejects, and TIME text in a shape it doesn't recognise, are left as-is.
 * - DECIMAL(p,s): rounded half away from zero to the column's scale (as MySQL rounds on store: `1.23456` in a
 *   DECIMAL(10,4) is stored as `1.2346`; a bare DECIMAL / DECIMAL(p) has scale 0), then compared as normalised
 *   decimal text, never through a float.
 * - Integers (TINYINT … BIGINT, YEAR): a fraction is rounded half away from zero in decimal text, as MySQL stores
 *   it (3.7 → 4, 2.5 → 3, -2.5 → -3, "3.7" → 4) — not with `Math.round`, which rounds -2.5 to -2. BIGINT then
 *   compares as normalised decimal text (`"007"` ≡ `7`), the others as numbers. Not modelled: YEAR's two-digit
 *   mapping (MySQL stores 24 as 2024 and 70 as 1970), so such a source value compares as changed.
 * - FLOAT(M,D) / DOUBLE(M,D): rounded to the declared scale with MySQL's own float64 arithmetic, which rounds an
 *   exact binary tie to even on the fraction (1.125 → 1.12) and a scale-0 tie down (0.5 → 0, -0.5 → -1). Then
 *   FLOAT compares at 6 significant digits (MySQL renders float32 that way: 3.14159265 reads back as 3.14159),
 *   DOUBLE at 15. Numeric text parses (`"12"` ≡ 12).
 * - Booleans count as 1 / 0 in integer and DECIMAL columns, as MySQL stores them (TINYINT(1) is MySQL's BOOLEAN).
 * - ENUM: case-folded to the declared member (`_ci` collations store the declared spelling: 'MIXED' → 'Mixed').
 * - SET: members case-folded, de-duplicated and put in declared order ('z,x,X' is stored as 'x,z').
 * - CHAR(n): trailing spaces dropped (MySQL strips them on retrieval).
 * - JSON: parsed JSON text compares as a value (MySQL normalises key order and whitespace). Inside it, a safe integer
 *   compares exactly and any other number at DOUBLE's 15 significant digits (12345678901234567000 ≡
 *   12345678901234570000, 0.30000000000000004 ≡ 0.3).
 * - Columns where the write path turns `''` into NULL compare `''` ≡ null ≡ absent (`emptyAsNull`, applied first).
 *
 * Read-only columns get no canonicalizer (they are never written). VARCHAR / TEXT and the other text-like columns
 * round-trip verbatim and compare structurally. The lossiness above is documented in the connector's STATE.md.
 */
import type { TSchema } from '@sinclair/typebox';
import {
  JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT,
  PostgresColumnType,
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { isPlainObject } from 'lodash';
import type {
  FieldValueCanonicalizer,
  FieldValueCanonicalizerContext,
} from 'src/remote-service/connectors/field-value-canonicalization';
import {
  composeCanonicalizers,
  decimalTextNormalized,
  emptyAsNull,
  numberRoundedToSignificantDigits,
  parsedJsonText,
} from 'src/remote-service/connectors/field-value-canonicalizers';
import type { BaseJsonTableSpec } from '../../types';
import { collectPgColumnNamesRejectingEmptyString } from '../pg-common/pg-empty-string-coercion';
import {
  classifyMySqlTemporalColumnType,
  isMySqlIntegerColumnType,
  readMySqlNativeColumnType,
  readMySqlNativeColumnTypeBaseName,
  type MySqlTemporalColumnType,
} from './mysql-native-column-type';
import { mysqlNativeColumnTypeRejectsEmptyString } from './mysql-record-preparation';
import {
  convertRecognizedTimeTextToMySqlTimeLiteral,
  convertTemporalValueToMySqlLiteral,
  readMySqlTimeColumnFractionalSecondsPrecision,
} from './mysql-temporal-literal';

/** MySQL renders FLOAT (float32) with 6 significant digits. */
const MYSQL_FLOAT_SIGNIFICANT_DIGITS = 6;
/** DOUBLE and the exact integer types compare at 15 significant digits (float64 re-rendering; Postgres parity). */
const MYSQL_DOUBLE_SIGNIFICANT_DIGITS = 15;

/**
 * Fallback without a native annotation: the temporal kind from the schema `format` the read side assigns
 * (`date` → DATE, `date-time` → TIMESTAMP, `date-time-local` → DATETIME), precision unknown. Mirrors the write path.
 */
function classifyMySqlTemporalColumnTypeFromSchemaFormat(
  schemaFormat: string | undefined,
): MySqlTemporalColumnType | undefined {
  switch (schemaFormat) {
    case 'date':
      return { temporalKind: 'date' };
    case 'date-time':
      return { temporalKind: 'timestamp', fractionalSecondsPrecision: undefined };
    case JSON_SCHEMA_LOCAL_DATE_TIME_FORMAT:
      return { temporalKind: 'datetime', fractionalSecondsPrecision: undefined };
    default:
      return undefined;
  }
}

/**
 * The literal the write path would send for a date / date-time string. With an unknown precision the literal keeps
 * the value's own fraction digits, so trailing zeros are dropped for comparison (`…:27.500` ≡ `…:27.5` ≡ the same
 * instant); with a known precision the converter already truncates and pads to it.
 */
function mysqlTemporalLiteralCanonicalizer(temporalColumnType: MySqlTemporalColumnType): FieldValueCanonicalizer {
  const fractionalSecondsPrecisionIsUnknown =
    temporalColumnType.temporalKind !== 'date' && temporalColumnType.fractionalSecondsPrecision === undefined;
  return (value) => {
    if (typeof value !== 'string') return value;
    const temporalLiteralConversion = convertTemporalValueToMySqlLiteral(value, temporalColumnType);
    if (temporalLiteralConversion.outcome !== 'converted') return value;
    if (!fractionalSecondsPrecisionIsUnknown) return temporalLiteralConversion.mySqlLiteral;
    return temporalLiteralConversion.mySqlLiteral.replace(
      /(\d{2}:\d{2}:\d{2})\.(\d*?)0*$/,
      (_wholeMatch: string, wholeSeconds: string, significantFractionDigits: string) =>
        significantFractionDigits ? `${wholeSeconds}.${significantFractionDigits}` : wholeSeconds,
    );
  };
}

/**
 * TIME(fsp): recognised TIME text becomes the literal the write path sends (and MySQL returns); anything else —
 * shapes the converter leaves to MySQL, non-strings — passes through.
 */
function mysqlTimeLiteralCanonicalizer(fractionalSecondsPrecision: number): FieldValueCanonicalizer {
  return (value) =>
    typeof value === 'string'
      ? (convertRecognizedTimeTextToMySqlTimeLiteral(value, fractionalSecondsPrecision) ?? value)
      : value;
}

/** `true` → 1, `false` → 0 (MySQL stores TRUE / FALSE as 1 / 0 in any numeric column); anything else passes through. */
const booleanAsZeroOrOne: FieldValueCanonicalizer = (value) => (typeof value === 'boolean' ? (value ? 1 : 0) : value);

/**
 * C's `rint` under the default rounding mode: the nearest integer, and on an exact tie the EVEN one (2.5 → 2,
 * 3.5 → 4, -2.5 → -2).
 */
function roundHalfToEvenLikeCRint(value: number): number {
  const floorOfValue = Math.floor(value);
  const distanceAboveFloor = value - floorOfValue;
  if (distanceAboveFloor < 0.5) return floorOfValue;
  if (distanceAboveFloor > 0.5) return floorOfValue + 1;
  return floorOfValue % 2 === 0 ? floorOfValue : floorOfValue + 1;
}

/**
 * A number, or a plain decimal literal string, rounded to `decimalPlaces` exactly as MySQL stores it into a
 * FLOAT(M,D) / DOUBLE(M,D) column, then rendered with `decimalPlaces` decimals as MySQL returns it. Everything else
 * passes through.
 *
 * MySQL (`truncate_double`) and MariaDB (`Field_real::truncate`) both compute
 * `floor(x) + rint((x - floor(x)) * 10^D) / 10^D` in float64, and this repeats those exact steps, because every
 * shortcut disagrees somewhere (verified against MySQL 8.4 and MariaDB 11.4):
 * - `toFixed` rounds an exact binary tie up (1.125 → 1.13), where `rint` picks the even digit (MySQL: 1.12);
 * - `rint(x * 10^D)` rounds a scale-0 tie to even (1.5 → 2, -0.5 → -0), where MySQL's `rint` only sees the
 *   fraction, so a scale-0 tie always goes DOWN (1.5 → 1, 3.5 → 3, -0.5 → -1); and its product rounds
 *   differently from the fraction's (1.055 * 100 is exactly 105.5 → 1.06, while MySQL gets 5.4999… → 1.05);
 * - decimal-text rounding ignores the float64 value: 2.675 is 2.67499999… in binary, so MySQL stores 2.67.
 */
function numberRoundedToDecimalPlacesAsMySqlStoresFloatingPoint(decimalPlaces: number): FieldValueCanonicalizer {
  // `Number('1e' + D)` is the correctly rounded power of ten, like the literal `log_10` table MySQL divides by
  // (`10 ** D` is off by an ulp for some D, e.g. 26 and 29).
  const powerOfTenForDecimalPlaces = Number(`1e${decimalPlaces}`);
  return (value) => {
    const numericValue =
      typeof value === 'string' && /^\s*-?\d+(\.\d+)?([eE][-+]?\d+)?\s*$/.test(value) ? Number(value) : value;
    if (typeof numericValue !== 'number' || !Number.isFinite(numericValue)) return value;
    const integerPartRoundedDown = Math.floor(numericValue);
    const fractionScaledToDecimalPlaces = (numericValue - integerPartRoundedDown) * powerOfTenForDecimalPlaces;
    const valueMySqlStores =
      integerPartRoundedDown + roundHalfToEvenLikeCRint(fractionScaledToDecimalPlaces) / powerOfTenForDecimalPlaces;
    // MySQL returns (M,D) values rendered with exactly D decimals; `toFixed` renders the stored double the same way.
    return Number(valueMySqlStores.toFixed(decimalPlaces));
  };
}

/**
 * Rewrite decimal text in exponent notation (`1e-7`, `1.5E+3`, or a JS number that `String()` renders that way) as
 * plain decimal text, so it can be rounded and normalised like any other decimal literal. Everything else passes
 * through.
 */
const decimalExponentTextExpanded: FieldValueCanonicalizer = (value) => {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string') return value;
  const exponentMatch = /^\s*([-+]?)(\d+)(?:\.(\d*))?[eE]([-+]?\d+)\s*$/.exec(text);
  if (!exponentMatch) return value;
  const [, sign, integerDigits, fractionDigits = '', exponentText] = exponentMatch;
  const exponent = Number(exponentText);
  // Absurd exponents (`1e400`) are not something MySQL would store as a DECIMAL either; compare them as-is.
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) return value;
  const allDigits = `${integerDigits}${fractionDigits}`;
  const decimalPointPosition = integerDigits.length + exponent;
  const paddedDigits =
    decimalPointPosition <= 0
      ? `${'0'.repeat(1 - decimalPointPosition)}${allDigits}`
      : allDigits.padEnd(decimalPointPosition, '0');
  const adjustedDecimalPointPosition = Math.max(decimalPointPosition, 1);
  const expandedIntegerDigits = paddedDigits.slice(0, adjustedDecimalPointPosition);
  const expandedFractionDigits = paddedDigits.slice(adjustedDecimalPointPosition);
  return `${sign === '-' ? '-' : ''}${expandedIntegerDigits}${expandedFractionDigits ? `.${expandedFractionDigits}` : ''}`;
};

/**
 * Round the TEXT of a decimal literal (or a finite number, rendered with `String()`) half away from zero to `scale`
 * fraction digits, without going through a float — what MySQL does when it stores a value into DECIMAL(p,scale).
 * Values that already fit, and anything that isn't a plain decimal literal, pass through (spelling is left to
 * `decimalTextNormalized`, apart from the `0` a leading-dot literal needs).
 */
function decimalTextRoundedHalfAwayFromZeroToScale(scale: number): FieldValueCanonicalizer {
  return (value) => {
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    if (typeof text !== 'string') return value;
    const decimalMatch = /^\s*([-+]?)(\d*)(?:\.(\d*))?\s*$/.exec(text);
    if (!decimalMatch) return value;
    const [, sign, integerDigits, fractionDigits = ''] = decimalMatch;
    if (integerDigits.length === 0 && fractionDigits.length === 0) return value;
    if (fractionDigits.length <= scale) {
      // Already fits. A leading-dot literal (`.5`, which MySQL stores as 0.50) gains its `0`, because
      // `decimalTextNormalized` only recognises literals with an integer digit.
      return integerDigits.length > 0 ? value : `${sign === '-' ? '-' : ''}0.${fractionDigits}`;
    }
    const keptDigitsAsInteger = BigInt(`${integerDigits || '0'}${fractionDigits.slice(0, scale)}`);
    const firstDroppedDigit = Number(fractionDigits[scale]);
    const roundedDigits = (keptDigitsAsInteger + (firstDroppedDigit >= 5 ? 1n : 0n))
      .toString()
      .padStart(scale + 1, '0');
    const roundedIntegerDigits = roundedDigits.slice(0, roundedDigits.length - scale);
    const roundedFractionDigits = roundedDigits.slice(roundedDigits.length - scale);
    return `${sign === '-' ? '-' : ''}${roundedIntegerDigits}${scale > 0 ? `.${roundedFractionDigits}` : ''}`;
  };
}

/**
 * The members of an `enum('a','it''s','b\\c')` / `set(...)` column type, unescaped (`''` → `'`, `\\` → `\`, as
 * `information_schema.COLUMNS.COLUMN_TYPE` prints them — verified on MySQL 8.4 and MariaDB 11.4). Undefined for
 * anything malformed or unexpected, in which case the column simply gets no member canonicalizer.
 */
export function parseMySqlEnumOrSetColumnTypeMembers(columnTypeSpelling: string): string[] | undefined {
  const memberListMatch = /^\s*(?:enum|set)\s*\(([\s\S]*)\)\s*$/i.exec(columnTypeSpelling);
  if (!memberListMatch) return undefined;
  const memberListText = memberListMatch[1];
  const members: string[] = [];
  let position = 0;
  while (position < memberListText.length) {
    if (memberListText[position] !== "'") return undefined;
    position += 1;
    let member = '';
    for (;;) {
      if (position >= memberListText.length) return undefined;
      const character = memberListText[position];
      if (character === "'") {
        if (memberListText[position + 1] === "'") {
          member += "'";
          position += 2;
          continue;
        }
        position += 1;
        break;
      }
      if (character === '\\') {
        const escapedCharacter = memberListText[position + 1];
        if (escapedCharacter !== '\\' && escapedCharacter !== "'") return undefined;
        member += escapedCharacter;
        position += 2;
        continue;
      }
      member += character;
      position += 1;
    }
    members.push(member);
    if (position === memberListText.length) break;
    if (memberListText[position] !== ',') return undefined;
    position += 1;
    if (position === memberListText.length) return undefined;
  }
  return members.length > 0 ? members : undefined;
}

/** Map each lower-cased member to its declared spelling and position (first declaration wins). */
function indexMySqlMembersByLowerCasedSpelling(
  declaredMembers: readonly string[],
): Map<string, { declaredMember: string; declaredPosition: number }> {
  const memberByLowerCasedSpelling = new Map<string, { declaredMember: string; declaredPosition: number }>();
  declaredMembers.forEach((declaredMember, declaredPosition) => {
    const lowerCasedMember = declaredMember.toLowerCase();
    if (!memberByLowerCasedSpelling.has(lowerCasedMember)) {
      memberByLowerCasedSpelling.set(lowerCasedMember, { declaredMember, declaredPosition });
    }
  });
  return memberByLowerCasedSpelling;
}

/** ENUM: a string matching a member case-insensitively becomes the declared spelling. */
function mysqlEnumMemberCanonicalizer(declaredMembers: readonly string[]): FieldValueCanonicalizer {
  const memberByLowerCasedSpelling = indexMySqlMembersByLowerCasedSpelling(declaredMembers);
  return (value) =>
    typeof value === 'string' ? (memberByLowerCasedSpelling.get(value.toLowerCase())?.declaredMember ?? value) : value;
}

/**
 * SET: a comma list whose every element matches a member becomes the de-duplicated declared spellings in declared
 * order. A list with an unknown element passes through (MySQL would have rejected it, so nothing was stored).
 */
function mysqlSetMembersCanonicalizer(declaredMembers: readonly string[]): FieldValueCanonicalizer {
  const memberByLowerCasedSpelling = indexMySqlMembersByLowerCasedSpelling(declaredMembers);
  return (value) => {
    if (typeof value !== 'string' || value === '') return value;
    const matchedDeclaredPositions = new Set<number>();
    for (const listElement of value.split(',')) {
      const matchedMember = memberByLowerCasedSpelling.get(listElement.toLowerCase());
      if (matchedMember === undefined) return value;
      matchedDeclaredPositions.add(matchedMember.declaredPosition);
    }
    return [...matchedDeclaredPositions]
      .sort((firstPosition, secondPosition) => firstPosition - secondPosition)
      .map((declaredPosition) => declaredMembers[declaredPosition])
      .join(',');
  };
}

/** CHAR(n): MySQL strips trailing spaces when the value is read back. */
const charValueWithTrailingSpacesTrimmed: FieldValueCanonicalizer = (value) =>
  typeof value === 'string' ? value.replace(/ +$/, '') : value;

const numberRoundedToDoubleSignificantDigits = numberRoundedToSignificantDigits(MYSQL_DOUBLE_SIGNIFICANT_DIGITS);

/**
 * Every number inside a JSON document that isn't a safe integer, rounded to DOUBLE's 15 significant digits; safe
 * integers stay exact, so a changed id inside a document still reads as a change. Arrays and plain objects are walked
 * into (never mutated); every other value passes through.
 *
 * Why (DEV-12415): the classic publish path can deliver such a number one float64 step off (Prisma rounds `Json`
 * input, DEV-12614), MySQL stores what it was sent, and an exact compare would then see the source's
 * 12345678901234567000 and the stored 12345678901234570000 as a change and re-publish the document on every run.
 */
const jsonDocumentNumbersComparedAtDoublePrecisionUnlessSafeInteger: FieldValueCanonicalizer = (value) => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : numberRoundedToDoubleSignificantDigits(value);
  }
  if (Array.isArray(value)) return value.map(jsonDocumentNumbersComparedAtDoublePrecisionUnlessSafeInteger);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([documentKey, documentValue]) => [
        documentKey,
        jsonDocumentNumbersComparedAtDoublePrecisionUnlessSafeInteger(documentValue),
      ]),
    );
  }
  return value;
};

/** JSON: JSON text parsed into the document it encodes, then its numbers compared as above. */
const mysqlJsonDocumentCanonicalizer: FieldValueCanonicalizer = composeCanonicalizers(
  parsedJsonText(),
  jsonDocumentNumbersComparedAtDoublePrecisionUnlessSafeInteger,
);

/**
 * Decimal text (and numbers, and exponent notation) rounded half away from zero to a whole number, as MySQL stores
 * a value with a fraction into an integer or scale-0 DECIMAL column: 3.7 → "4", 2.5 → "3", -2.5 → "-3",
 * "2.5e0" → "3" (verified on MySQL 8.4 and MariaDB 11.4, for numbers and for text). Rounded in decimal text, never
 * with `Math.round` (which rounds -2.5 to -2) and never through a float (a BIGINT above 2^53 stays exact). Whole
 * numbers pass through unchanged; the caller's normaliser settles their spelling.
 */
const decimalTextRoundedHalfAwayFromZeroToWholeNumber: FieldValueCanonicalizer = composeCanonicalizers(
  decimalExponentTextExpanded,
  decimalTextRoundedHalfAwayFromZeroToScale(0),
);

/** The first `(M,D)` scale of a `float(7,3)` / `double(10,2)` / `decimal(10,2)` spelling, if any. */
function readMySqlNumericColumnTypeScale(nativeColumnTypeSpelling: string): number | undefined {
  const scaleMatch = /^\s*[a-z]+\s*\(\s*\d+\s*,\s*(\d+)\s*\)/i.exec(nativeColumnTypeSpelling);
  return scaleMatch ? Number(scaleMatch[1]) : undefined;
}

/** The canonicalizer for a column of this exact native MySQL type, or undefined when it compares structurally. */
export function mysqlFieldValueCanonicalizerForNativeColumnType(
  nativeColumnTypeSpelling: string,
): FieldValueCanonicalizer | undefined {
  const temporalColumnType = classifyMySqlTemporalColumnType(nativeColumnTypeSpelling);
  if (temporalColumnType !== undefined) return mysqlTemporalLiteralCanonicalizer(temporalColumnType);
  const timeColumnFractionalSecondsPrecision = readMySqlTimeColumnFractionalSecondsPrecision(nativeColumnTypeSpelling);
  if (timeColumnFractionalSecondsPrecision !== undefined) {
    return mysqlTimeLiteralCanonicalizer(timeColumnFractionalSecondsPrecision);
  }

  const baseTypeName = readMySqlNativeColumnTypeBaseName(nativeColumnTypeSpelling);
  switch (baseTypeName) {
    case 'json':
      return mysqlJsonDocumentCanonicalizer;
    case 'decimal':
    case 'numeric': {
      // A bare DECIMAL is DECIMAL(10,0) and DECIMAL(p) is DECIMAL(p,0): both store whole numbers.
      const decimalScale = readMySqlNumericColumnTypeScale(nativeColumnTypeSpelling) ?? 0;
      return composeCanonicalizers(
        booleanAsZeroOrOne,
        decimalExponentTextExpanded,
        decimalTextRoundedHalfAwayFromZeroToScale(decimalScale),
        decimalTextNormalized(),
      );
    }
    case 'bigint':
      return composeCanonicalizers(
        booleanAsZeroOrOne,
        decimalTextRoundedHalfAwayFromZeroToWholeNumber,
        decimalTextNormalized(),
      );
    case 'float':
    case 'double':
    case 'real': {
      const significantDigits =
        baseTypeName === 'float' ? MYSQL_FLOAT_SIGNIFICANT_DIGITS : MYSQL_DOUBLE_SIGNIFICANT_DIGITS;
      const declaredScale = readMySqlNumericColumnTypeScale(nativeColumnTypeSpelling);
      const significantDigitsCanonicalizer = numberRoundedToSignificantDigits(significantDigits, {
        parseNumericStrings: true,
      });
      return declaredScale === undefined
        ? significantDigitsCanonicalizer
        : composeCanonicalizers(
            numberRoundedToDecimalPlacesAsMySqlStoresFloatingPoint(declaredScale),
            significantDigitsCanonicalizer,
          );
    }
    case 'enum':
    case 'set': {
      const declaredMembers = parseMySqlEnumOrSetColumnTypeMembers(nativeColumnTypeSpelling);
      if (declaredMembers === undefined) return undefined;
      return baseTypeName === 'enum'
        ? mysqlEnumMemberCanonicalizer(declaredMembers)
        : mysqlSetMembersCanonicalizer(declaredMembers);
    }
    case 'char':
      return charValueWithTrailingSpacesTrimmed;
    default:
      break;
  }
  if (isMySqlIntegerColumnType(nativeColumnTypeSpelling) || baseTypeName === 'year') {
    // TINYINT(1) is MySQL's BOOLEAN; every integer type stores TRUE / FALSE as 1 / 0, and rounds a fraction.
    return composeCanonicalizers(
      booleanAsZeroOrOne,
      decimalTextRoundedHalfAwayFromZeroToWholeNumber,
      numberRoundedToSignificantDigits(MYSQL_DOUBLE_SIGNIFICANT_DIGITS, { parseNumericStrings: true }),
    );
  }
  return undefined;
}

/**
 * Fallback for a column without a MySQL native type annotation: the shared `x-scratch-connector-data-type`
 * family plus the schema `format` (Postgres-parity rules, since the exact type is unknown).
 */
function mysqlFieldValueCanonicalizerForColumnFamily(
  connectorDataType: unknown,
  schemaFormat: string | undefined,
): FieldValueCanonicalizer | undefined {
  switch (connectorDataType) {
    case PostgresColumnType.TIMESTAMP: {
      const temporalColumnType = classifyMySqlTemporalColumnTypeFromSchemaFormat(schemaFormat);
      return temporalColumnType !== undefined ? mysqlTemporalLiteralCanonicalizer(temporalColumnType) : undefined;
    }
    case PostgresColumnType.NUMERIC:
      return numberRoundedToSignificantDigits(MYSQL_DOUBLE_SIGNIFICANT_DIGITS, { parseNumericStrings: true });
    case PostgresColumnType.NUMERIC_STRING:
      return composeCanonicalizers(decimalExponentTextExpanded, decimalTextNormalized());
    case PostgresColumnType.JSONB:
      return mysqlJsonDocumentCanonicalizer;
    default:
      return undefined;
  }
}

/** Memo: the column names whose shared family rejects `''` (the write path's rule), once per table spec. */
const columnNamesRejectingEmptyStringByFamilyMemo = new WeakMap<BaseJsonTableSpec, Set<string>>();

function columnFamilyRejectsEmptyString(tableSpec: BaseJsonTableSpec, columnName: string): boolean {
  let columnNamesRejectingEmptyString = columnNamesRejectingEmptyStringByFamilyMemo.get(tableSpec);
  if (columnNamesRejectingEmptyString === undefined) {
    columnNamesRejectingEmptyString = collectPgColumnNamesRejectingEmptyString(tableSpec);
    columnNamesRejectingEmptyStringByFamilyMemo.set(tableSpec, columnNamesRejectingEmptyString);
  }
  return columnNamesRejectingEmptyString.has(columnName);
}

function isReadOnlyFieldSchema(fieldSchema: TSchema | undefined): boolean {
  return fieldSchema !== undefined && (fieldSchema as Record<string, unknown>)[X_SCRATCH_READONLY] === true;
}

/**
 * Registry hook (`resolveFieldValueCanonicalizer`) for the MySQL connector. Resolves the column's exact native
 * type from `x-scratch-native-column-type` (set by `fetchJsonTableSpec`), falling back to the shared column family
 * when a schema predates it. Pure, total and synchronous; returns undefined for read-only columns and for columns
 * that round-trip verbatim.
 */
export function resolveMySqlFieldValueCanonicalizer(
  context: FieldValueCanonicalizerContext,
): FieldValueCanonicalizer | undefined {
  if (context.schemaField.readonly === true || isReadOnlyFieldSchema(context.fieldSchema)) return undefined;

  const nativeColumnTypeSpelling = readMySqlNativeColumnType(context.fieldSchema);
  const connectorDataType =
    context.fieldSchema === undefined
      ? undefined
      : (context.fieldSchema as Record<string, unknown>)[X_SCRATCH_CONNECTOR_DATA_TYPE];
  const columnValueCanonicalizer =
    nativeColumnTypeSpelling !== undefined
      ? mysqlFieldValueCanonicalizerForNativeColumnType(nativeColumnTypeSpelling)
      : mysqlFieldValueCanonicalizerForColumnFamily(connectorDataType, context.schemaField.format);

  // The write path writes `''` as NULL for exactly these columns (mysql-record-preparation.ts), so `''` stored
  // earlier reads back as null and must compare equal to it.
  const writePathTurnsEmptyStringIntoNull =
    columnFamilyRejectsEmptyString(context.tableSpec, context.fieldPath) ||
    (nativeColumnTypeSpelling !== undefined && mysqlNativeColumnTypeRejectsEmptyString(nativeColumnTypeSpelling));
  if (!writePathTurnsEmptyStringIntoNull) return columnValueCanonicalizer;
  return columnValueCanonicalizer === undefined
    ? emptyAsNull()
    : composeCanonicalizers(emptyAsNull(), columnValueCanonicalizer);
}
