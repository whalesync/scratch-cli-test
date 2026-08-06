/**
 * Tests for the spreadsheet serial-date conversions: the shared pure functions
 * (`@spinner/shared-types/transform`), the two sync transformers built on them,
 * and the `serial_date_to_iso` display-transformer arm. Run here because
 * shared-types has no test infra of its own (same arrangement as
 * display-transformer.spec.ts).
 */
import {
  applyClientSafeTransformer,
  applyDisplayTransformer,
  isoStringToSerialDateNumber,
  serialDateNumberToIsoString,
} from '@spinner/shared-types/transform';
import { isoToSerialDateTransformer } from '../implementations/iso-to-serial-date.transformer';
import { serialDateToIsoTransformer } from '../implementations/serial-date-to-iso.transformer';
import { TransformContext } from '../transformer.types';

function contextFor(sourceValue: unknown, options?: Record<string, unknown>): TransformContext {
  return { sourceValue, options } as unknown as TransformContext;
}

describe('serialDateNumberToIsoString', () => {
  it('converts whole-day serials to date-only strings', () => {
    // 2025-08-01 is 45870 days after 1899-12-30.
    expect(serialDateNumberToIsoString(45870)).toBe('2025-08-01');
    expect(serialDateNumberToIsoString(1)).toBe('1899-12-31');
  });

  it('converts fractional serials to wall-clock date-times (no timezone suffix)', () => {
    expect(serialDateNumberToIsoString(45870.5)).toBe('2025-08-01T12:00:00');
    expect(serialDateNumberToIsoString(45870.25)).toBe('2025-08-01T06:00:00');
  });

  it('rounds float noise to whole seconds', () => {
    // 0.1 days = 8640s exactly, but floats give 8639.999…; must not render 08:23:59.
    expect(serialDateNumberToIsoString(45870.1)).toBe('2025-08-01T02:24:00');
  });

  it('honors forced output shapes', () => {
    expect(serialDateNumberToIsoString(45870, 'datetime')).toBe('2025-08-01T00:00:00');
    expect(serialDateNumberToIsoString(45870.5, 'date')).toBe('2025-08-01');
  });

  it('rejects non-finite and absurd values', () => {
    expect(serialDateNumberToIsoString(Number.NaN)).toBeNull();
    expect(serialDateNumberToIsoString(Number.POSITIVE_INFINITY)).toBeNull();
    expect(serialDateNumberToIsoString(4e6)).toBeNull();
  });
});

describe('isoStringToSerialDateNumber', () => {
  it('converts date-only and wall-clock strings verbatim', () => {
    expect(isoStringToSerialDateNumber('2025-08-01')).toBe(45870);
    expect(isoStringToSerialDateNumber('2025-08-01T12:00:00')).toBe(45870.5);
    expect(isoStringToSerialDateNumber('2025-08-01 06:00:00')).toBe(45870.25);
  });

  it('normalizes zoned instants to their UTC wall clock', () => {
    expect(isoStringToSerialDateNumber('2025-08-01T12:00:00Z')).toBe(45870.5);
    expect(isoStringToSerialDateNumber('2025-08-01T14:00:00+02:00')).toBe(45870.5);
  });

  it('round-trips with serialDateNumberToIsoString', () => {
    for (const serial of [45870, 45870.5, 1035.75]) {
      const isoString = serialDateNumberToIsoString(serial);
      expect(isoString).not.toBeNull();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(isoStringToSerialDateNumber(isoString!)).toBe(serial);
    }
  });

  it('rejects garbage', () => {
    expect(isoStringToSerialDateNumber('')).toBeNull();
    expect(isoStringToSerialDateNumber('not a date')).toBeNull();
  });

  it('fails closed on non-ISO shapes instead of falling back to host-timezone Date.parse', () => {
    // Date.parse would read '8/1/2025' in the HOST timezone (stored value would
    // depend on where the server runs) and '45870' as the YEAR 45870.
    expect(isoStringToSerialDateNumber('8/1/2025')).toBeNull();
    expect(isoStringToSerialDateNumber('45870')).toBeNull();
    expect(isoStringToSerialDateNumber('Aug 1 2025')).toBeNull();
  });

  it('truncates sub-millisecond precision on wall-clock strings (Postgres timestamps)', () => {
    expect(isoStringToSerialDateNumber('2025-08-01T12:00:00.123456')).toBe(
      isoStringToSerialDateNumber('2025-08-01T12:00:00.123'),
    );
    // Still timezone-free: the fractional wall-clock stays a wall clock.
    expect(isoStringToSerialDateNumber('2025-08-01T12:00:00.000000')).toBe(45870.5);
  });
});

describe('serial_date_to_iso sync transformer', () => {
  it('converts serials (and numeric strings) to ISO', async () => {
    await expect(serialDateToIsoTransformer.transform(contextFor(45870))).resolves.toEqual({
      success: true,
      value: '2025-08-01',
    });
    await expect(serialDateToIsoTransformer.transform(contextFor('45870.5'))).resolves.toEqual({
      success: true,
      value: '2025-08-01T12:00:00',
    });
  });

  it('passes empty through as null and fails cleanly on non-numbers', async () => {
    await expect(serialDateToIsoTransformer.transform(contextFor(null))).resolves.toEqual({
      success: true,
      value: null,
    });
    const failed = await serialDateToIsoTransformer.transform(contextFor('yesterday'));
    expect(failed.success).toBe(false);
  });

  it('honors the isoShape option', async () => {
    await expect(serialDateToIsoTransformer.transform(contextFor(45870, { isoShape: 'datetime' }))).resolves.toEqual({
      success: true,
      value: '2025-08-01T00:00:00',
    });
  });
});

describe('iso_to_serial_date sync transformer', () => {
  it('converts ISO strings to serials', async () => {
    await expect(isoToSerialDateTransformer.transform(contextFor('2025-08-01T12:00:00Z'))).resolves.toEqual({
      success: true,
      value: 45870.5,
    });
  });

  it('passes numbers through unchanged (already a serial) and empty as null', async () => {
    await expect(isoToSerialDateTransformer.transform(contextFor(45870))).resolves.toEqual({
      success: true,
      value: 45870,
    });
    await expect(isoToSerialDateTransformer.transform(contextFor(''))).resolves.toEqual({ success: true, value: null });
  });

  it('fails cleanly on unparseable strings', async () => {
    const failed = await isoToSerialDateTransformer.transform(contextFor('not a date'));
    expect(failed.success).toBe(false);
  });
});

describe('serial_date_to_iso display transformer arm', () => {
  it('renders serial numbers as ISO strings', () => {
    expect(applyDisplayTransformer({ type: 'serial_date_to_iso' }, 45870)).toEqual({ ok: true, value: '2025-08-01' });
    expect(applyDisplayTransformer({ type: 'serial_date_to_iso' }, 45870.5)).toEqual({
      ok: true,
      value: '2025-08-01T12:00:00',
    });
  });

  it('fails closed (raw value shown) for non-numeric cells', () => {
    expect(applyDisplayTransformer({ type: 'serial_date_to_iso' }, 'hello')).toEqual({ ok: false });
    expect(applyDisplayTransformer({ type: 'serial_date_to_iso' }, { a: 1 })).toEqual({ ok: false });
  });

  it("never renders an empty-string cell as the 1899 epoch (Number('') is 0)", () => {
    expect(applyDisplayTransformer({ type: 'serial_date_to_iso' }, '')).toEqual({ ok: false });
    expect(applyDisplayTransformer({ type: 'serial_date_to_iso' }, '  ')).toEqual({ ok: false });
  });
});

describe('client-safe codec arms', () => {
  it('runs serial_date_to_iso and iso_to_serial_date on the client applier', () => {
    expect(applyClientSafeTransformer({ type: 'serial_date_to_iso' }, 45870)).toEqual({
      ok: true,
      value: '2025-08-01',
    });
    expect(applyClientSafeTransformer({ type: 'iso_to_serial_date' }, '2025-08-01')).toEqual({
      ok: true,
      value: 45870,
    });
    expect(applyClientSafeTransformer({ type: 'iso_to_serial_date' }, 'garbage')).toEqual({ ok: false });
  });
});
