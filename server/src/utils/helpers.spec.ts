import { elideToMaxLength, stringToEnum } from './helpers';

enum TestEnum {
  FOO = 'foo',
  BAR = 'bar',
  BAZ_CASE = 'baz-case',
}

describe('Utility Helpers', () => {
  describe('stringToEnum', () => {
    it('should return enum value when matching case name', () => {
      const result = stringToEnum('FOO', TestEnum, null);

      expect(result).toBe(TestEnum.FOO);
      expect(result).toBe('foo');
    });

    it('should return enum value when matching case value', () => {
      const result = stringToEnum('foo', TestEnum, null);

      expect(result).toBe(TestEnum.FOO);
      expect(result).toBe('foo');
    });

    it('should return default value when no match found', () => {
      const result = stringToEnum('invalid', TestEnum, 'default');

      expect(result).toBe('default');
    });

    it('should return null as default value when no match found', () => {
      const result = stringToEnum('invalid', TestEnum, null);

      expect(result).toBeNull();
    });

    it('should handle enum cases with underscores', () => {
      const result1 = stringToEnum('BAZ_CASE', TestEnum, null);
      const result2 = stringToEnum('baz-case', TestEnum, null);

      expect(result1).toBe(TestEnum.BAZ_CASE);
      expect(result1).toBe('baz-case');
      expect(result2).toBe(TestEnum.BAZ_CASE);
    });

    it('should work with BAR enum case', () => {
      const result1 = stringToEnum('BAR', TestEnum, null);
      const result2 = stringToEnum('bar', TestEnum, null);

      expect(result1).toBe(TestEnum.BAR);
      expect(result2).toBe(TestEnum.BAR);
    });

    it('should return default for empty string', () => {
      const result = stringToEnum('', TestEnum, 'default');

      expect(result).toBe('default');
    });

    it('should be case-sensitive', () => {
      const result1 = stringToEnum('Foo', TestEnum, 'default');
      const result2 = stringToEnum('FOo', TestEnum, 'default');

      expect(result1).toBe('default');
      expect(result2).toBe('default');
    });

    it('should handle different default value types', () => {
      const resultString = stringToEnum('invalid', TestEnum, 'defaultString');
      const resultNumber = stringToEnum('invalid', TestEnum, 42);
      const resultBoolean = stringToEnum('invalid', TestEnum, false);
      const resultObject = stringToEnum('invalid', TestEnum, { default: true });

      expect(resultString).toBe('defaultString');
      expect(resultNumber).toBe(42);
      expect(resultBoolean).toBe(false);
      expect(resultObject).toEqual({ default: true });
    });

    it('should prioritize exact key match over value match', () => {
      // In case of enum where key matches another enum's value
      enum EdgeCaseEnum {
        foo = 'bar',
        bar = 'baz',
      }

      const result = stringToEnum('foo', EdgeCaseEnum, null);

      // Should match the key 'foo' which has value 'bar'
      expect(result).toBe(EdgeCaseEnum.foo);
      expect(result).toBe('bar');
    });

    it('should handle undefined default value', () => {
      const result = stringToEnum('invalid', TestEnum, undefined);

      expect(result).toBeUndefined();
    });

    it('should match first occurrence when searching', () => {
      const result1 = stringToEnum('FOO', TestEnum, null);
      const result2 = stringToEnum('BAR', TestEnum, null);
      const result3 = stringToEnum('BAZ_CASE', TestEnum, null);

      expect(result1).toBe('foo');
      expect(result2).toBe('bar');
      expect(result3).toBe('baz-case');
    });
  });

  describe('elideToMaxLength', () => {
    it('returns the text unchanged when it already fits', () => {
      expect(elideToMaxLength('short name', 20)).toBe('short name');
      expect(elideToMaxLength('exactly ten', 11)).toBe('exactly ten');
    });

    it('elides from the middle, keeping both ends', () => {
      const result = elideToMaxLength('My Very Long Document Name', 20);
      expect(result).toHaveLength(20);
      expect(result).toContain('…');
      expect(result.startsWith('My Very')).toBe(true);
      // The distinguishing end of the name survives.
      expect(result.endsWith('Name')).toBe(true);
    });

    it('preserves trailing digits (the distinguishing suffix)', () => {
      const result = elideToMaxLength('Report Q3 2024 final version 17', 18);
      expect(result).toHaveLength(18);
      expect(result.endsWith('17')).toBe(true);
    });

    it('keeps the whole file extension intact', () => {
      const result = elideToMaxLength('My Very Long Document Name.pdf', 20);
      expect(result).toHaveLength(20);
      expect(result.endsWith('.pdf')).toBe(true);
      // The ellipsis must not land inside the extension.
      expect(result.indexOf('…')).toBeLessThan(result.indexOf('.pdf'));
    });

    it('does not treat a dotted identifier or trailing period as an extension', () => {
      // `created_by.identifier` is a dotted path, not `name.ext`; the long suffix is not an extension.
      const dotted = elideToMaxLength('created_by.some_very_long_identifier_segment', 20);
      expect(dotted).toHaveLength(20);
      // Both ends are still kept; nothing special about the dot.
      expect(dotted.startsWith('created')).toBe(true);
    });

    it('two names sharing a long prefix stay distinct after elision', () => {
      const northAmerica = elideToMaxLength('Customer Orders 2024 North America', 22);
      const europe = elideToMaxLength('Customer Orders 2024 Europe', 22);
      expect(northAmerica).not.toBe(europe);
    });

    it('never exceeds maxLength', () => {
      for (const maxLength of [1, 2, 3, 5, 10, 20, 63, 255]) {
        const result = elideToMaxLength('a'.repeat(300) + '.json', maxLength);
        expect(result.length).toBeLessThanOrEqual(maxLength);
      }
    });

    it('hard-cuts from the front when there is no room for the ellipsis', () => {
      expect(elideToMaxLength('abcdef', 1)).toBe('a');
      expect(elideToMaxLength('abcdef', 0)).toBe('');
    });

    it('honours a custom ellipsis string', () => {
      const result = elideToMaxLength('My Very Long Document Name', 20, { ellipsis: '...' });
      expect(result).toHaveLength(20);
      expect(result).toContain('...');
    });

    it('treats a negative maxLength as zero', () => {
      expect(elideToMaxLength('anything', -5)).toBe('');
    });
  });
});
