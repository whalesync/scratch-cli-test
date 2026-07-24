import { ValueMapOptions } from '@spinner/shared-types';
import { applyClientSafeTransformer } from '@spinner/shared-types/transform';
import { Service } from 'src/remote-service/connectors/service-constants';
import { valueMapTransformer } from '../implementations/value-map.transformer';
import { createNullLookupTools } from '../lookup-tools';
import { SyncRecord, TransformContext } from '../transformer.types';

const OPTION_ID_TO_LABEL_MAPPING: ValueMapOptions['mapping'] = {
  '33': 'Opt, B',
  '34': 'émoji 🚀 opt',
  open: 'Open',
};

function createContext(sourceValue: unknown, options: ValueMapOptions): TransformContext {
  const sourceRecord: SyncRecord = { id: 'test', filePath: '/test', fields: { value: sourceValue } };
  return {
    sourceRecord,
    sourceFieldPath: 'value',
    sourceValue,
    sourceTableSpec: null,
    sourceService: Service.PIPEDRIVE,
    destinationFieldPath: 'value',
    destinationTableSpec: null,
    destinationService: Service.AIRTABLE,
    lookupTools: createNullLookupTools(),
    options,
    phase: 'DATA',
  };
}

describe('valueMapTransformer', () => {
  it('should have correct type', () => {
    expect(valueMapTransformer.type).toBe('value_map');
  });

  it('maps a NUMBER value through its string-form key (a Pipedrive enum option id)', async () => {
    const result = await valueMapTransformer.transform(createContext(33, { mapping: OPTION_ID_TO_LABEL_MAPPING }));
    expect(result).toEqual({ success: true, value: 'Opt, B' });
  });

  it('maps a string value directly (a key_string option id)', async () => {
    const result = await valueMapTransformer.transform(createContext('open', { mapping: OPTION_ID_TO_LABEL_MAPPING }));
    expect(result).toEqual({ success: true, value: 'Open' });
  });

  it('passes an unmapped scalar through as its string form by default (open option sets)', async () => {
    const result = await valueMapTransformer.transform(createContext(99, { mapping: OPTION_ID_TO_LABEL_MAPPING }));
    expect(result).toEqual({ success: true, value: '99' });
  });

  it('maps an unmapped scalar to null under onUnmapped: null', async () => {
    const result = await valueMapTransformer.transform(
      createContext(99, { mapping: OPTION_ID_TO_LABEL_MAPPING, onUnmapped: 'null' }),
    );
    expect(result).toEqual({ success: true, value: null });
  });

  it.each([null, undefined, ''])('maps empty input %p to null', async (emptyValue) => {
    const result = await valueMapTransformer.transform(
      createContext(emptyValue, { mapping: OPTION_ID_TO_LABEL_MAPPING }),
    );
    expect(result).toEqual({ success: true, value: null });
  });

  it('fails (useOriginal) on a non-scalar value — arrays go through map_array', async () => {
    const result = await valueMapTransformer.transform(
      createContext([33, 34], { mapping: OPTION_ID_TO_LABEL_MAPPING }),
    );
    expect(result).toMatchObject({ success: false, useOriginal: true });
  });

  // The client-side applier must stay byte-for-byte in step with this server implementation, so a
  // grid edit and a sync agree on the same value.
  describe('client-safe applier parity', () => {
    it.each([
      [33, 'Opt, B'],
      ['open', 'Open'],
      [99, '99'],
      [null, null],
      ['', null],
    ])('applyClientSafeTransformer(value_map, %p) === %p', (inputValue, expectedValue) => {
      const clientResult = applyClientSafeTransformer(
        { type: 'value_map', options: { mapping: OPTION_ID_TO_LABEL_MAPPING } },
        inputValue,
      );
      expect(clientResult).toEqual({ ok: true, value: expectedValue });
    });

    it('fails closed on a non-scalar value', () => {
      const clientResult = applyClientSafeTransformer(
        { type: 'value_map', options: { mapping: OPTION_ID_TO_LABEL_MAPPING } },
        [33],
      );
      expect(clientResult).toEqual({ ok: false });
    });

    it('maps an array element-wise when nested under map_array', () => {
      const clientResult = applyClientSafeTransformer(
        {
          type: 'map_array',
          options: { elementTransformer: { type: 'value_map', options: { mapping: OPTION_ID_TO_LABEL_MAPPING } } },
        },
        [33, 34, 99],
      );
      expect(clientResult).toEqual({ ok: true, value: ['Opt, B', 'émoji 🚀 opt', '99'] });
    });
  });
});
