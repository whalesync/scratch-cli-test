import { toWriteFieldData, toWriteValue, translateValueToId } from '../framer-connector';
import { FramerWriteTranslationMaps } from '../framer-types';

const MAPS: FramerWriteTranslationMaps = {
  // Stage enum: case names AND ids both resolve to the id.
  enumCaseIdByValue: {
    fStage: { Draft: 'caseDraft', Review: 'caseReview', Live: 'caseLive', caseLive: 'caseLive' },
  },
  // Primary Tag reference: target slugs AND ids both resolve to the item id.
  refItemIdByValue: {
    fTag: { design: 'itemDesign', engineering: 'itemEng', itemDesign: 'itemDesign' },
    fTags: { design: 'itemDesign', engineering: 'itemEng' },
  },
};

describe('translateValueToId', () => {
  it('maps an enum case name to its case id', () => {
    expect(translateValueToId('enum', 'fStage', 'Live', MAPS)).toBe('caseLive');
    expect(translateValueToId('enum', 'fStage', 'Review', MAPS)).toBe('caseReview');
  });

  it('passes an enum value through when it is already a case id', () => {
    expect(translateValueToId('enum', 'fStage', 'caseLive', MAPS)).toBe('caseLive');
  });

  it('maps a single reference slug to its item id', () => {
    expect(translateValueToId('collectionReference', 'fTag', 'engineering', MAPS)).toBe('itemEng');
  });

  it('maps a multi-reference array of slugs to item ids', () => {
    expect(translateValueToId('multiCollectionReference', 'fTags', ['design', 'engineering'], MAPS)).toEqual([
      'itemDesign',
      'itemEng',
    ]);
  });

  it('passes an unmapped value through unchanged (lets the service surface its own error)', () => {
    expect(translateValueToId('enum', 'fStage', 'Nonexistent', MAPS)).toBe('Nonexistent');
    expect(translateValueToId('collectionReference', 'fTag', 'ghost', MAPS)).toBe('ghost');
  });

  it('leaves non-translatable field types untouched', () => {
    expect(translateValueToId('string', 'fTitle', 'hello', MAPS)).toBe('hello');
    expect(translateValueToId('number', 'fCount', 42, MAPS)).toBe(42);
  });

  it('handles null/non-string values gracefully', () => {
    expect(translateValueToId('enum', 'fStage', null, MAPS)).toBeNull();
    expect(translateValueToId('multiCollectionReference', 'fTags', null, MAPS)).toBeNull();
  });
});

describe('toWriteValue', () => {
  it('extracts the url from an image/file asset object', () => {
    expect(toWriteValue('image', { id: 'x', url: 'https://cdn/x.png' })).toBe('https://cdn/x.png');
    expect(toWriteValue('file', { url: 'https://cdn/x.pdf' })).toBe('https://cdn/x.pdf');
  });

  it('passes a plain url string through for an asset field', () => {
    expect(toWriteValue('image', 'https://cdn/y.png')).toBe('https://cdn/y.png');
  });

  it('coerces undefined to null and passes scalars through', () => {
    expect(toWriteValue('string', undefined)).toBeNull();
    expect(toWriteValue('boolean', false)).toBe(false);
    expect(toWriteValue('number', 0)).toBe(0);
  });
});

describe('toWriteFieldData', () => {
  it('builds {type,value} entries and drops valueByLocale', () => {
    const out = toWriteFieldData({
      fTitle: { type: 'string', value: 'Hi', valueByLocale: {} },
      fCount: { type: 'number', value: 5 },
    });
    expect(out).toEqual({
      fTitle: { type: 'string', value: 'Hi' },
      fCount: { type: 'number', value: 5 },
    });
  });

  it('skips malformed entries', () => {
    expect(toWriteFieldData({ bad: { value: 'x' } as unknown as { type: string; value: unknown } })).toEqual({});
    expect(toWriteFieldData(undefined)).toEqual({});
  });
});
