import { EncryptionService } from './encryption';

describe('EncryptionService', () => {
  let encryptionService: EncryptionService;
  const testMasterKey = 'a'.repeat(32); // 32 character master key

  beforeEach(() => {
    encryptionService = new EncryptionService(testMasterKey);
  });

  describe('constructor', () => {
    it('should create service with valid master key', () => {
      expect(() => new EncryptionService('a'.repeat(32))).not.toThrow();
    });

    it('should throw error for short master key', () => {
      expect(() => new EncryptionService('short')).toThrow('Master key must be at least 32 characters long');
    });

    it('should throw error for empty master key', () => {
      expect(() => new EncryptionService('')).toThrow('Master key must be at least 32 characters long');
    });

    it('should throw error for undefined master key', () => {
      expect(() => new EncryptionService(undefined as unknown as string)).toThrow(
        'Master key must be at least 32 characters long',
      );
    });
  });

  describe('encrypt', () => {
    it('should encrypt a simple string', async () => {
      const plaintext = 'Hello, World!';
      const result = await encryptionService.encrypt(plaintext);

      expect(result).toHaveProperty('encrypted');
      expect(result).toHaveProperty('iv');
      expect(result).toHaveProperty('salt');
      expect(result.encrypted).toBeTruthy();
      expect(result.iv).toBeTruthy();
      expect(result.salt).toBeTruthy();
    });

    it('should return empty strings for empty input', async () => {
      const result = await encryptionService.encrypt('');

      expect(result).toEqual({
        encrypted: '',
        iv: '',
        salt: '',
      });
    });

    it('should produce different encrypted results for same plaintext', async () => {
      const plaintext = 'test message';
      const result1 = await encryptionService.encrypt(plaintext);
      const result2 = await encryptionService.encrypt(plaintext);

      // Different IV and salt should produce different encrypted results
      expect(result1.encrypted).not.toEqual(result2.encrypted);
      expect(result1.iv).not.toEqual(result2.iv);
      expect(result1.salt).not.toEqual(result2.salt);
    });

    it('should encrypt long strings', async () => {
      const plaintext = 'a'.repeat(10000);
      const result = await encryptionService.encrypt(plaintext);

      expect(result.encrypted).toBeTruthy();
      expect(result.iv).toBeTruthy();
      expect(result.salt).toBeTruthy();
    });

    it('should encrypt special characters', async () => {
      const plaintext = '!@#$%^&*()_+-=[]{}|;:",.<>?/~`';
      const result = await encryptionService.encrypt(plaintext);

      expect(result.encrypted).toBeTruthy();
    });

    it('should encrypt Unicode characters', async () => {
      const plaintext = '你好世界 🌍 Ñoño';
      const result = await encryptionService.encrypt(plaintext);

      expect(result.encrypted).toBeTruthy();
    });

    it('should encrypt JSON strings', async () => {
      const plaintext = JSON.stringify({ key: 'value', nested: { data: 123 } });
      const result = await encryptionService.encrypt(plaintext);

      expect(result.encrypted).toBeTruthy();
    });
  });

  describe('decrypt', () => {
    // Suppress console.error for expected decryption failures
    let consoleErrorSpy: jest.SpyInstance;

    beforeEach(() => {
      consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      consoleErrorSpy.mockRestore();
    });

    it('should decrypt encrypted text back to original', async () => {
      const plaintext = 'Hello, World!';
      const encrypted = await encryptionService.encrypt(plaintext);
      const decrypted = await encryptionService.decrypt(encrypted);

      expect(decrypted).toEqual(plaintext);
    });

    it('should return empty string for empty encrypted data', async () => {
      const result = await encryptionService.decrypt({
        encrypted: '',
        iv: '',
        salt: '',
      });

      expect(result).toEqual('');
    });

    it('should handle long text round-trip', async () => {
      const plaintext = 'a'.repeat(10000);
      const encrypted = await encryptionService.encrypt(plaintext);
      const decrypted = await encryptionService.decrypt(encrypted);

      expect(decrypted).toEqual(plaintext);
    });

    it('should handle special characters round-trip', async () => {
      const plaintext = '!@#$%^&*()_+-=[]{}|;:",.<>?/~`';
      const encrypted = await encryptionService.encrypt(plaintext);
      const decrypted = await encryptionService.decrypt(encrypted);

      expect(decrypted).toEqual(plaintext);
    });

    it('should handle Unicode characters round-trip', async () => {
      const plaintext = '你好世界 🌍 Ñoño';
      const encrypted = await encryptionService.encrypt(plaintext);
      const decrypted = await encryptionService.decrypt(encrypted);

      expect(decrypted).toEqual(plaintext);
    });

    it('should handle JSON strings round-trip', async () => {
      const plaintext = JSON.stringify({ key: 'value', nested: { data: 123 } });
      const encrypted = await encryptionService.encrypt(plaintext);
      const decrypted = await encryptionService.decrypt(encrypted);

      expect(decrypted).toEqual(plaintext);
    });

    it('should throw error for tampered encrypted data', async () => {
      const plaintext = 'Hello, World!';
      const encrypted = await encryptionService.encrypt(plaintext);

      // Tamper with the authentication tag (last 32 hex chars)
      const tampered = encrypted.encrypted.slice(0, -32) + 'a'.repeat(32);
      encrypted.encrypted = tampered;

      await expect(encryptionService.decrypt(encrypted)).rejects.toThrow('Failed to decrypt data');
    });

    it('should throw error for wrong IV', async () => {
      const plaintext = 'Hello, World!';
      const encrypted = await encryptionService.encrypt(plaintext);

      // Change the IV
      encrypted.iv = 'a'.repeat(32);

      await expect(encryptionService.decrypt(encrypted)).rejects.toThrow('Failed to decrypt data');
    });

    it('should throw error for wrong salt', async () => {
      const plaintext = 'Hello, World!';
      const encrypted = await encryptionService.encrypt(plaintext);

      // Change the salt
      encrypted.salt = 'b'.repeat(64);

      await expect(encryptionService.decrypt(encrypted)).rejects.toThrow('Failed to decrypt data');
    });

    it('should not decrypt with different master key', async () => {
      const plaintext = 'Hello, World!';
      const encrypted = await encryptionService.encrypt(plaintext);

      // Create a different service with different master key
      const differentService = new EncryptionService('b'.repeat(32));

      await expect(differentService.decrypt(encrypted)).rejects.toThrow('Failed to decrypt data');
    });
  });

  describe('encryptObject', () => {
    it('should encrypt a simple object', async () => {
      const obj = { key: 'value', number: 42 };
      const result = await encryptionService.encryptObject(obj);

      expect(result).toHaveProperty('encrypted');
      expect(result).toHaveProperty('iv');
      expect(result).toHaveProperty('salt');
      expect(result.encrypted).toBeTruthy();
    });

    it('should encrypt a nested object', async () => {
      const obj = {
        user: { name: 'John', email: 'john@example.com' },
        settings: { theme: 'dark', notifications: true },
      };
      const result = await encryptionService.encryptObject(obj);

      expect(result.encrypted).toBeTruthy();
    });

    it('should encrypt an object with arrays', async () => {
      const obj = {
        items: [1, 2, 3],
        names: ['Alice', 'Bob', 'Charlie'],
      };
      const result = await encryptionService.encryptObject(obj);

      expect(result.encrypted).toBeTruthy();
    });

    it('should encrypt an empty object', async () => {
      const obj = {};
      const result = await encryptionService.encryptObject(obj);

      expect(result.encrypted).toBeTruthy();
    });
  });

  describe('decryptObject', () => {
    it('should decrypt encrypted object back to original', async () => {
      const obj = { key: 'value', number: 42 };
      const encrypted = await encryptionService.encryptObject(obj);
      const decrypted = await encryptionService.decryptObject(encrypted);

      expect(decrypted).toEqual(obj);
    });

    it('should handle nested object round-trip', async () => {
      const obj = {
        user: { name: 'John', email: 'john@example.com' },
        settings: { theme: 'dark', notifications: true },
      };
      const encrypted = await encryptionService.encryptObject(obj);
      const decrypted = await encryptionService.decryptObject(encrypted);

      expect(decrypted).toEqual(obj);
    });

    it('should handle object with arrays round-trip', async () => {
      const obj = {
        items: [1, 2, 3],
        names: ['Alice', 'Bob', 'Charlie'],
      };
      const encrypted = await encryptionService.encryptObject(obj);
      const decrypted = await encryptionService.decryptObject(encrypted);

      expect(decrypted).toEqual(obj);
    });

    it('should return empty object for empty encrypted data', async () => {
      const result = await encryptionService.decryptObject({
        encrypted: '',
        iv: '',
        salt: '',
      });

      expect(result).toEqual({});
    });

    it('should handle complex object with special characters', async () => {
      const obj = {
        message: 'Hello 世界!',
        symbols: '!@#$%^&*()',
        emoji: '🎉🌟',
      };
      const encrypted = await encryptionService.encryptObject(obj);
      const decrypted = await encryptionService.decryptObject(encrypted);

      expect(decrypted).toEqual(obj);
    });

    it('should preserve data types in round-trip', async () => {
      const obj = {
        string: 'text',
        number: 123,
        boolean: true,
        null: null,
        array: [1, 'two', false],
      };
      const encrypted = await encryptionService.encryptObject(obj);
      const decrypted = await encryptionService.decryptObject(encrypted);

      expect(decrypted).toEqual(obj);
      expect(typeof decrypted.string).toBe('string');
      expect(typeof decrypted.number).toBe('number');
      expect(typeof decrypted.boolean).toBe('boolean');
      expect(decrypted.null).toBeNull();
      expect(Array.isArray(decrypted.array)).toBe(true);
    });
  });

  describe('security properties', () => {
    it('should use different IV for each encryption', async () => {
      const plaintext = 'test';
      const result1 = await encryptionService.encrypt(plaintext);
      const result2 = await encryptionService.encrypt(plaintext);

      expect(result1.iv).not.toEqual(result2.iv);
    });

    it('should use different salt for each encryption', async () => {
      const plaintext = 'test';
      const result1 = await encryptionService.encrypt(plaintext);
      const result2 = await encryptionService.encrypt(plaintext);

      expect(result1.salt).not.toEqual(result2.salt);
    });

    it('should produce IV of correct length', async () => {
      const result = await encryptionService.encrypt('test');
      const ivBuffer = Buffer.from(result.iv, 'hex');

      // IV should be 16 bytes (128 bits)
      expect(ivBuffer.length).toBe(16);
    });

    it('should produce salt of correct length', async () => {
      const result = await encryptionService.encrypt('test');
      const saltBuffer = Buffer.from(result.salt, 'hex');

      // Salt should be 32 bytes (256 bits)
      expect(saltBuffer.length).toBe(32);
    });
  });
});
