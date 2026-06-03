import {
  AnyId,
  createId,
  createPlainId,
  createUserId,
  IdPrefixes,
  isConnectorAccountId,
  isId,
  isUserId,
  isWorkbookId,
  typeForId,
} from '@spinner/shared-types';

// Mock nanoid to avoid ESM import issues in Jest
jest.mock('nanoid', () => ({
  customAlphabet: () => () => 'abcd123456',
}));

describe('ID Utilities', () => {
  describe('createId', () => {
    it('should create an ID with the correct prefix', () => {
      const id = createId(IdPrefixes.USER);

      expect(id).toMatch(/^usr_[A-Za-z0-9]{10}$/);
    });

    it('should create IDs with correct length', () => {
      const id = createId(IdPrefixes.WORKBOOK);

      expect(id.length).toBe(14); // 4 chars prefix + 10 chars random
    });

    it('should create IDs with consistent format (mocked)', () => {
      const id1 = createId(IdPrefixes.USER);
      const id2 = createId(IdPrefixes.USER);

      // With mocked nanoid, both should have the same format
      expect(id1).toBe('usr_abcd123456');
      expect(id2).toBe('usr_abcd123456');
    });

    it('should work with different prefixes', () => {
      const userId = createId(IdPrefixes.USER);
      const workbookId = createId(IdPrefixes.WORKBOOK);
      const connectorId = createId(IdPrefixes.CONNECTOR_ACCOUNT);

      expect(userId).toMatch(/^usr_/);
      expect(workbookId).toMatch(/^wkb_/);
      expect(connectorId).toMatch(/^coa_/);
    });
  });

  describe('createPlainId', () => {
    it('should create an ID without prefix', () => {
      const id = createPlainId();

      expect(id).toMatch(/^[A-Za-z0-9]{10}$/);
    });

    it('should create IDs with correct length', () => {
      const id = createPlainId();

      expect(id.length).toBe(10);
    });

    it('should create IDs with consistent format (mocked)', () => {
      const id1 = createPlainId();
      const id2 = createPlainId();

      // With mocked nanoid, both return the same value
      expect(id1).toBe('abcd123456');
      expect(id2).toBe('abcd123456');
    });
  });

  describe('isId', () => {
    it('should return true for valid IDs with correct prefix', () => {
      const validId = 'usr_1234567890';

      expect(isId(validId, IdPrefixes.USER)).toBe(true);
    });

    it('should return false for IDs with wrong prefix', () => {
      const id = 'usr_1234567890';

      expect(isId(id, IdPrefixes.WORKBOOK)).toBe(false);
    });

    it('should return false for IDs with incorrect length', () => {
      const tooShort = 'usr_123';
      const tooLong = 'usr_12345678901234567890';

      expect(isId(tooShort, IdPrefixes.USER)).toBe(false);
      expect(isId(tooLong, IdPrefixes.USER)).toBe(false);
    });

    it('should return false for non-string values', () => {
      expect(isId(123, IdPrefixes.USER)).toBe(false);
      expect(isId(null, IdPrefixes.USER)).toBe(false);
      expect(isId(undefined, IdPrefixes.USER)).toBe(false);
      expect(isId({}, IdPrefixes.USER)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isId('', IdPrefixes.USER)).toBe(false);
    });
  });

  describe('type-specific isId functions', () => {
    describe('isUserId', () => {
      it('should return true for valid user IDs', () => {
        const userId = createUserId();

        expect(isUserId(userId)).toBe(true);
      });

      it('should return false for non-user IDs', () => {
        expect(isUserId('sna_1234567890')).toBe(false);
        expect(isUserId('invalid')).toBe(false);
        expect(isUserId(null)).toBe(false);
      });
    });

    describe('isWorkbookId', () => {
      it('should return true for valid workbook IDs', () => {
        const id = 'wkb_1234567890';

        expect(isWorkbookId(id)).toBe(true);
      });

      it('should return true for legacy workbook IDs', () => {
        const id = 'sna_1234567890';

        expect(isWorkbookId(id)).toBe(true);
      });

      it('should return false for non-workbook IDs', () => {
        expect(isWorkbookId('usr_1234567890')).toBe(false);
        expect(isWorkbookId('invalid')).toBe(false);
      });
    });

    describe('isConnectorAccountId', () => {
      it('should return true for valid connector account IDs', () => {
        const id = 'coa_1234567890';

        expect(isConnectorAccountId(id)).toBe(true);
      });

      it('should return false for non-connector account IDs', () => {
        expect(isConnectorAccountId('usr_1234567890')).toBe(false);
        expect(isConnectorAccountId('invalid')).toBe(false);
      });
    });
  });

  describe('typeForId', () => {
    it('should return correct type for user ID', () => {
      const userId = 'usr_1234567890' as AnyId;

      expect(typeForId(userId)).toBe('USER');
    });

    it('should return correct type for workbook ID', () => {
      const workbookId = 'wkb_1234567890' as AnyId;

      expect(typeForId(workbookId)).toBe('WORKBOOK');
    });

    it('should return correct type for connector account ID', () => {
      const connectorId = 'coa_1234567890' as AnyId;

      expect(typeForId(connectorId)).toBe('CONNECTOR_ACCOUNT');
    });

    it('should return correct type for API token ID', () => {
      const tokenId = 'atk_1234567890' as AnyId;

      expect(typeForId(tokenId)).toBe('API_TOKEN');
    });

    it('should return correct type for subscription ID', () => {
      const subId = 'sub_1234567890' as AnyId;

      expect(typeForId(subId)).toBe('SUBSCRIPTION');
    });

    it('should return correct type for organization ID', () => {
      const orgId = 'org_1234567890' as AnyId;

      expect(typeForId(orgId)).toBe('ORGANIZATION');
    });

    it('should return null for unrecognized prefix', () => {
      const invalidId = 'xxx_1234567890' as AnyId;

      expect(typeForId(invalidId)).toBeNull();
    });

    it('should return null for invalid ID format', () => {
      const invalidId = 'not_an_id' as AnyId;

      expect(typeForId(invalidId)).toBeNull();
    });
  });

  describe('type-specific createId functions', () => {
    it('should create valid user IDs', () => {
      const userId = createUserId();

      expect(isUserId(userId)).toBe(true);
      expect(userId).toMatch(/^usr_/);
    });

    it('should create IDs that pass typeForId check', () => {
      const userId = createUserId();
      const type = typeForId(userId as AnyId);

      expect(type).toBe('USER');
    });
  });

  describe('ID format consistency', () => {
    it('should not contain dashes or underscores in random part', () => {
      // Generate multiple IDs to check the alphabet
      const ids = Array.from({ length: 100 }, () => createPlainId());

      ids.forEach((id) => {
        const randomPart = id;
        expect(randomPart).not.toMatch(/[-_]/);
      });
    });

    it('should use alphanumeric characters only in random part', () => {
      const id = createPlainId();

      expect(id).toMatch(/^[A-Za-z0-9]+$/);
    });
  });

  describe('edge cases', () => {
    it('should handle all defined ID prefixes', () => {
      const prefixes = Object.values(IdPrefixes);

      prefixes.forEach((prefix) => {
        const id = createId(prefix);
        expect(id).toMatch(new RegExp(`^${prefix.replace('_', '_')}`));
        // Sentinel prefixes (`scratch_pending_publish_`,
        // `scratch_pending_recreate_`) are longer than the standard 11-char
        // prefix and don't constrain id length the same way. They're
        // synthesized (sometimes with a real-id suffix for recreate) rather
        // than generated by `createId` in production.
        const isSentinelPrefix =
          prefix === IdPrefixes.SCRATCH_PENDING_PUBLISH || prefix === IdPrefixes.SCRATCH_PENDING_RECREATE;
        if (!isSentinelPrefix) {
          expect(id.length).toBe(14);
        }
      });
    });

    it('should create IDs with different prefixes', () => {
      const userId = createUserId();
      const workbookId = createId(IdPrefixes.WORKBOOK);
      const connectorId = createId(IdPrefixes.CONNECTOR_ACCOUNT);
      const tokenId = createId(IdPrefixes.API_TOKEN);
      const subId = createId(IdPrefixes.SUBSCRIPTION);

      // All have different prefixes even though random part is the same (mocked)
      expect(userId).toBe('usr_abcd123456');
      expect(workbookId).toBe('wkb_abcd123456');
      expect(connectorId).toBe('coa_abcd123456');
      expect(tokenId).toBe('atk_abcd123456');
      expect(subId).toBe('sub_abcd123456');
    });
  });
});
