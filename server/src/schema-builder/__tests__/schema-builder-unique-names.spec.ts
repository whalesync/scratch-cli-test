import type { NameCharacterRules } from '@spinner/shared-types';
import {
  allocateUniqueName,
  convertNameToNameStyle,
  elideNameToMaxLength,
  fitNameToCharacterRules,
  foldNameToLowercaseSqlIdentifier,
  normalizeNameForUniqueness,
} from '../schema-builder-unique-names';

describe('normalizeNameForUniqueness', () => {
  it('trims and lowercases (matching the zod duplicate rule)', () => {
    expect(normalizeNameForUniqueness('  Name  ')).toBe('name');
    expect(normalizeNameForUniqueness('NAME')).toBe('name');
  });
});

describe('allocateUniqueName', () => {
  it('returns the requested name unchanged when free, and records it as taken', () => {
    const taken = new Set<string>();
    expect(allocateUniqueName('Title', taken)).toBe('Title');
    expect(taken.has('title')).toBe(true);
  });

  it('appends " 2", " 3", … to successive duplicates (original keeps its bare name)', () => {
    const taken = new Set<string>();
    expect(allocateUniqueName('Tags', taken)).toBe('Tags');
    expect(allocateUniqueName('Tags', taken)).toBe('Tags 2');
    expect(allocateUniqueName('Tags', taken)).toBe('Tags 3');
  });

  it('collides case-insensitively', () => {
    const taken = new Set<string>();
    expect(allocateUniqueName('Name', taken)).toBe('Name');
    // 'name' normalizes to the same key as 'Name', so it is suffixed.
    expect(allocateUniqueName('name', taken)).toBe('name 2');
  });

  it('skips a suffix that is itself already taken (cascading collision)', () => {
    const taken = new Set<string>(['base', 'base 2']);
    expect(allocateUniqueName('base', taken)).toBe('base 3');
  });

  it('honors a pre-seeded set (e.g. existing destination names)', () => {
    const taken = new Set<string>(['name', 'bio']);
    // Collides with the seed → suffixed.
    expect(allocateUniqueName('Name', taken)).toBe('Name 2');
    // Free against the seed → unchanged, then recorded.
    expect(allocateUniqueName('Age', taken)).toBe('Age');
    expect(allocateUniqueName('Age', taken)).toBe('Age 2');
  });

  describe('with a maxLength', () => {
    it('elides a too-long name to fit the limit', () => {
      const taken = new Set<string>();
      const result = allocateUniqueName('a_very_long_field_name_that_overflows', taken, 20);
      expect(result.length).toBeLessThanOrEqual(20);
      expect(result).toContain('…');
    });

    it('leaves room for the dedup suffix so the suffixed name still fits', () => {
      const taken = new Set<string>();
      const first = allocateUniqueName('a_very_long_field_name_that_overflows', taken, 20);
      const second = allocateUniqueName('a_very_long_field_name_that_overflows', taken, 20);
      expect(first.length).toBeLessThanOrEqual(20);
      expect(second.length).toBeLessThanOrEqual(20);
      expect(second).not.toBe(first);
      expect(second.endsWith(' 2')).toBe(true);
    });

    it('leaves a name that already fits unchanged', () => {
      const taken = new Set<string>();
      expect(allocateUniqueName('Short', taken, 63)).toBe('Short');
    });

    it("keeps the bare and the suffixed name within a limit measured in 'utf8Bytes'", () => {
      const taken = new Set<string>();
      const longName = 'Customer Lifetime Value Projection Including Discounts And Refunds Q3';
      const first = allocateUniqueName(longName, taken, 63, 'utf8Bytes');
      const second = allocateUniqueName(longName, taken, 63, 'utf8Bytes');
      expect(Buffer.byteLength(first, 'utf8')).toBeLessThanOrEqual(63);
      expect(Buffer.byteLength(second, 'utf8')).toBeLessThanOrEqual(63);
      expect(second.endsWith(' 2')).toBe(true);
    });
  });
});

describe('elideNameToMaxLength', () => {
  it('passes the name through unchanged when no limit is given', () => {
    expect(elideNameToMaxLength('a'.repeat(300))).toHaveLength(300);
  });

  it('middle-elides to the limit when given', () => {
    const result = elideNameToMaxLength('a_very_long_field_name_that_overflows', 20);
    expect(result.length).toBeLessThanOrEqual(20);
    expect(result).toContain('…');
  });
});

describe('fitNameToCharacterRules (DEV-12413)', () => {
  const ALL_RULES: NameCharacterRules = {
    basicMultilingualPlaneOnly: true,
    noControlCharacters: true,
    noTrailingSpace: true,
  };

  it('returns the name unchanged when no rules are given', () => {
    expect(fitNameToCharacterRules('Mood \u{1F600} ', undefined, 'Field')).toBe('Mood \u{1F600} ');
  });

  it.each([
    ['an emoji at the end', 'Mood \u{1F600}', 'Mood'],
    ['an emoji in the middle', 'Hot \u{1F525} Deals', 'Hot Deals'],
    ['an emoji at the start', '\u{1F525} Deals', 'Deals'],
    ['an emoji between letters', 'Hot\u{1F525}Deals', 'Hot Deals'],
    ['several emoji in a row', 'Mood \u{1F600}\u{1F622}', 'Mood'],
    ['a zero-width-joiner sequence', 'Family \u{1F468}\u200d\u{1F469}\u200d\u{1F467} Plan', 'Family Plan'],
    ['a skin-tone modifier', 'Likes \u{1F44D}\u{1F3FD}', 'Likes'],
    ['a heart with a variation selector joined to an emoji', 'Hot \u2764\ufe0f\u200d\u{1F525}', 'Hot \u2764'],
    ['a line break', 'First\nName', 'First Name'],
    ['a tab with spaces around it', 'First \t Name', 'First Name'],
    ['a NUL character', 'sentinel\u0000name', 'sentinel name'],
    ['a trailing space', 'Trailing space ', 'Trailing space'],
    ['several trailing spaces', 'Trailing   ', 'Trailing'],
  ])('removes %s', (_label, name, expected) => {
    expect(fitNameToCharacterRules(name, ALL_RULES, 'Field')).toBe(expected);
  });

  it.each([
    ['only emoji', '\u{1F600}'],
    ['only spaces', '   '],
    ['only emoji and spaces', ' \u{1F600} \u{1F525} '],
  ])('falls back when the name is %s', (_label, name) => {
    expect(fitNameToCharacterRules(name, ALL_RULES, 'Field')).toBe('Field');
  });

  it.each([
    ['a plain name', 'Customer Name'],
    ['a heart below U+FFFF', 'Love \u2764\ufe0f'],
    ['accented and CJK letters', 'Größe 名前'],
    ['a leading space', ' Leading'],
    ['an ellipsis from elision', 'Customer…Name'],
  ])('leaves %s unchanged', (_label, name) => {
    expect(fitNameToCharacterRules(name, ALL_RULES, 'Field')).toBe(name);
  });

  it('removes only what the rules forbid', () => {
    expect(fitNameToCharacterRules('Mood \u{1F600} ', { noTrailingSpace: true }, 'Field')).toBe('Mood \u{1F600}');
    expect(fitNameToCharacterRules('First\nName \u{1F600}', { noControlCharacters: true }, 'Field')).toBe(
      'First Name \u{1F600}',
    );
    expect(fitNameToCharacterRules('Mood \u{1F600} ', { basicMultilingualPlaneOnly: true }, 'Field')).toBe('Mood');
  });
});

describe('foldNameToLowercaseSqlIdentifier', () => {
  it.each([
    ['Payment Intents', 'payment_intents'],
    ['Address (City)', 'address_city'],
    ['Invoice Settings (Default Payment Method)', 'invoice_settings_default_payment_method'],
    ['Café Notes', 'cafe_notes'],
    ['  --HubSpot & Notion--  ', 'hubspot_notion'],
    ['already_snake_case', 'already_snake_case'],
    ['Order', 'order'],
  ])('folds %j to %j', (name, expected) => {
    expect(foldNameToLowercaseSqlIdentifier(name, '_')).toBe(expected);
  });

  it('prefixes a leading digit with the given prefix', () => {
    expect(foldNameToLowercaseSqlIdentifier('2FA Enabled', '_')).toBe('_2fa_enabled');
    expect(foldNameToLowercaseSqlIdentifier('2026 export', 's_')).toBe('s_2026_export');
  });

  it('returns an empty string when nothing usable is left', () => {
    expect(foldNameToLowercaseSqlIdentifier('\u{1F680}', '_')).toBe('');
    expect(foldNameToLowercaseSqlIdentifier('...', '_')).toBe('');
    expect(foldNameToLowercaseSqlIdentifier('顧客', '_')).toBe('');
  });
});

describe('convertNameToNameStyle', () => {
  it("leaves an 'asGiven' name unchanged", () => {
    expect(convertNameToNameStyle('Address (City)', 'asGiven', 'Field')).toBe('Address (City)');
  });

  it("converts a 'lowercaseSqlIdentifier' name, falling back to the converted fallback when nothing is left", () => {
    expect(convertNameToNameStyle('Address (City)', 'lowercaseSqlIdentifier', 'Field')).toBe('address_city');
    expect(convertNameToNameStyle('Café Notes', 'lowercaseSqlIdentifier', 'Field')).toBe('cafe_notes');
    expect(convertNameToNameStyle('\u{1F680}', 'lowercaseSqlIdentifier', 'Field')).toBe('field');
    expect(convertNameToNameStyle('--- !!', 'lowercaseSqlIdentifier', 'Field')).toBe('field');
  });

  it.each(['名前', 'Имя (полное)', '顧客 ID', 'שם', '이름', 'Straße'])(
    "keeps %j as it is: a 'lowercaseSqlIdentifier' conversion would drop its letters",
    (name) => {
      expect(convertNameToNameStyle(name, 'lowercaseSqlIdentifier', 'Field')).toBe(name);
    },
  );
});

describe("name style 'lowercaseSqlIdentifier' in shortening and dedup", () => {
  const LONG_SQL_NAME = 'invoice_settings_rendering_options_amount_tax_display_preference_for_the_customer_portal';

  it('suffixes a duplicate with _2, _3, …', () => {
    const taken = new Set<string>();
    expect(allocateUniqueName('address_line1', taken, 63, 'utf8Bytes', 'lowercaseSqlIdentifier')).toBe('address_line1');
    expect(allocateUniqueName('address_line1', taken, 63, 'utf8Bytes', 'lowercaseSqlIdentifier')).toBe(
      'address_line1_2',
    );
    expect(allocateUniqueName('address_line1', taken, 63, 'utf8Bytes', 'lowercaseSqlIdentifier')).toBe(
      'address_line1_3',
    );
  });

  it('shortens from the middle with a single "_", never "…" or a doubled or trailing "_"', () => {
    const shortenedName = elideNameToMaxLength(LONG_SQL_NAME, 63, 'utf8Bytes', 'lowercaseSqlIdentifier');
    expect(Buffer.byteLength(shortenedName, 'utf8')).toBeLessThanOrEqual(63);
    expect(shortenedName).toMatch(/^[a-z0-9_]+$/);
    expect(shortenedName).not.toMatch(/__|_$/);
    expect(shortenedName.startsWith('invoice_settings_')).toBe(true);
    expect(shortenedName.endsWith('_customer_portal')).toBe(true);
  });

  it('collapses the "_" the cut leaves beside an existing separator', () => {
    // A 9-character budget keeps "abcd" + "_" + "_ghi"; the joined "__" collapses to one.
    expect(elideNameToMaxLength('abcd_efgh_ghi', 9, 'characters', 'lowercaseSqlIdentifier')).toBe('abcd_ghi');
  });

  it('keeps a shortened, suffixed name within the limit', () => {
    const taken = new Set<string>();
    const first = allocateUniqueName(LONG_SQL_NAME, taken, 63, 'utf8Bytes', 'lowercaseSqlIdentifier');
    const second = allocateUniqueName(LONG_SQL_NAME, taken, 63, 'utf8Bytes', 'lowercaseSqlIdentifier');
    expect(second).not.toBe(first);
    expect(Buffer.byteLength(second, 'utf8')).toBeLessThanOrEqual(63);
    expect(second).toMatch(/^[a-z0-9_]+_2$/);
  });
});
