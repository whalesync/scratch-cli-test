import { Type } from '@sinclair/typebox';
import { EpochToIsoOptions } from '@spinner/shared-types';
import { epochToIsoTransformer } from '../implementations/epoch-to-iso.transformer';
import { TransformContext } from '../transformer.types';

function createContext(sourceValue: unknown, options: EpochToIsoOptions = {}): TransformContext {
  return { sourceValue, options } as TransformContext;
}

async function transform(sourceValue: unknown, options: EpochToIsoOptions = {}) {
  return epochToIsoTransformer.transform(createContext(sourceValue, options));
}

describe('epochToIsoTransformer', () => {
  it('has the expected type', () => {
    expect(epochToIsoTransformer.type).toBe('epoch_to_iso');
  });

  it('converts epoch seconds to ISO-8601 by default', async () => {
    // 1785436554 → the value the Stripe audit saw exported as a raw number.
    await expect(transform(1785436554)).resolves.toEqual({ success: true, value: '2026-07-30T18:35:54.000Z' });
  });

  it('converts epoch milliseconds when told to', async () => {
    await expect(transform(1785436554000, { unit: 'milliseconds' })).resolves.toEqual({
      success: true,
      value: '2026-07-30T18:35:54.000Z',
    });
  });

  it('treats the epoch itself as a real time, not as empty', async () => {
    await expect(transform(0)).resolves.toEqual({ success: true, value: '1970-01-01T00:00:00.000Z' });
  });

  it('handles a pre-epoch (negative) timestamp', async () => {
    await expect(transform(-86400)).resolves.toEqual({ success: true, value: '1969-12-31T00:00:00.000Z' });
  });

  it('accepts a numeric string, for services that store epochs as strings', async () => {
    await expect(transform('1785436554')).resolves.toEqual({ success: true, value: '2026-07-30T18:35:54.000Z' });
  });

  it.each([[null], [undefined], ['']])('passes %p through as null', async (sourceValue) => {
    await expect(transform(sourceValue)).resolves.toEqual({ success: true, value: null });
  });

  it('fails loudly on a non-numeric value rather than inventing a date', async () => {
    const result = await transform('not-a-timestamp');

    expect(result).toEqual({
      success: false,
      error: 'Expected a Unix timestamp number, got "not-a-timestamp"',
      useOriginal: true,
    });
  });

  it('fails on a non-scalar value', async () => {
    await expect(transform({ created: 1 })).resolves.toMatchObject({ success: false, useOriginal: true });
  });

  it('rejects a value outside the representable date range instead of throwing', async () => {
    const result = await transform(1e18);

    expect(result).toMatchObject({ success: false, useOriginal: true });
    expect((result as { error: string }).error).toContain('outside the representable date range');
  });

  describe('returnType', () => {
    it('predicts an ISO date-time string', () => {
      expect(epochToIsoTransformer.returnType?.(Type.Number())).toEqual(Type.String({ format: 'date-time' }));
    });

    it('accepts a nullable union, which is how every optional epoch field is declared', () => {
      expect(() => epochToIsoTransformer.returnType?.(Type.Union([Type.Number(), Type.Null()]))).not.toThrow();
    });

    it('rejects an input that cannot be a timestamp', () => {
      expect(() => epochToIsoTransformer.returnType?.(Type.Object({}))).toThrow(/expects a number input/);
    });
  });
});
