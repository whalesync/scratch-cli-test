import { NonWritableFieldEditError, NonWritableFieldReason, nonWritableFieldEditErrorMessage } from './error';

describe('nonWritableFieldEditErrorMessage', () => {
  const closingSingular = 'Undo the change to this field, then publish again.';
  const closingPlural = 'Undo the change to these fields, then publish again.';

  describe('read-only fields', () => {
    it('produces the singular message (unchanged from the pre-DEV-10607 wording)', () => {
      expect(nonWritableFieldEditErrorMessage({ [NonWritableFieldReason.ReadOnly]: ['createdAt'] })).toBe(
        `Field "createdAt" is read-only and cannot be published. ${closingSingular}`,
      );
    });

    it('produces the plural message', () => {
      expect(nonWritableFieldEditErrorMessage({ [NonWritableFieldReason.ReadOnly]: ['createdAt', 'statistics'] })).toBe(
        `Fields "createdAt", "statistics" are read-only and cannot be published. ${closingPlural}`,
      );
    });
  });

  describe('set-on-create-only (write-once) fields', () => {
    it('produces the singular message', () => {
      expect(nonWritableFieldEditErrorMessage({ [NonWritableFieldReason.SetOnCreateOnly]: ['author'] })).toBe(
        `Field "author" cannot be edited after the record is created. ${closingSingular}`,
      );
    });

    it('produces the plural message', () => {
      expect(nonWritableFieldEditErrorMessage({ [NonWritableFieldReason.SetOnCreateOnly]: ['blog', 'author'] })).toBe(
        `Fields "blog", "author" cannot be edited after the record is created. ${closingPlural}`,
      );
    });
  });

  describe('not-yet-supported fields', () => {
    it('produces the singular message', () => {
      expect(nonWritableFieldEditErrorMessage({ [NonWritableFieldReason.NotYetSupported]: ['assignees'] })).toBe(
        `Field "assignees" cannot be published because editing it is not yet supported. ${closingSingular}`,
      );
    });

    it('produces the plural message', () => {
      expect(
        nonWritableFieldEditErrorMessage({ [NonWritableFieldReason.NotYetSupported]: ['assignees', 'tags'] }),
      ).toBe(
        `Fields "assignees", "tags" cannot be published because editing them is not yet supported. ${closingPlural}`,
      );
    });
  });

  describe('multiple categories in one message', () => {
    it('emits one clause per non-empty category and closes with the total field count', () => {
      expect(
        nonWritableFieldEditErrorMessage({
          [NonWritableFieldReason.ReadOnly]: ['archivedAt'],
          [NonWritableFieldReason.SetOnCreateOnly]: ['createdAt'],
        }),
      ).toBe(
        'Field "archivedAt" is read-only and cannot be published. ' +
          `Field "createdAt" cannot be edited after the record is created. ${closingPlural}`,
      );
    });

    it('orders clauses read-only, set-on-create-only, not-yet-supported regardless of key order', () => {
      // Keys deliberately supplied out of order to prove the output order is fixed.
      expect(
        nonWritableFieldEditErrorMessage({
          [NonWritableFieldReason.NotYetSupported]: ['c'],
          [NonWritableFieldReason.SetOnCreateOnly]: ['b'],
          [NonWritableFieldReason.ReadOnly]: ['a'],
        }),
      ).toBe(
        'Field "a" is read-only and cannot be published. ' +
          'Field "b" cannot be edited after the record is created. ' +
          `Field "c" cannot be published because editing it is not yet supported. ${closingPlural}`,
      );
    });

    it('ignores empty category arrays (closing sentence uses the real total)', () => {
      expect(
        nonWritableFieldEditErrorMessage({
          [NonWritableFieldReason.ReadOnly]: ['createdAt'],
          [NonWritableFieldReason.SetOnCreateOnly]: [],
        }),
      ).toBe(`Field "createdAt" is read-only and cannot be published. ${closingSingular}`);
    });
  });
});

describe('NonWritableFieldEditError', () => {
  it('exposes the message as a user-friendly message and keeps its name', () => {
    const message = nonWritableFieldEditErrorMessage({ [NonWritableFieldReason.ReadOnly]: ['createdAt'] });
    const error = new NonWritableFieldEditError(message);

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NonWritableFieldEditError');
    expect(error.message).toBe(message);
    expect(error.userFriendlyMessage).toBe(message);
  });
});
