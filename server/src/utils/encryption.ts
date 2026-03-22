import { createCipheriv, createDecipheriv, randomBytes, scrypt } from 'crypto';
import { promisify } from 'util';

const scryptAsync = promisify(scrypt);

export type EncryptedData = {
  encrypted: string;
  iv: string;
  salt: string;
};

export class EncryptionService {
  private readonly algorithm = 'aes-256-gcm';
  private readonly keyLength = 32; // 256 bits
  private readonly ivLength = 16; // 128 bits
  private readonly saltLength = 32; // 256 bits

  constructor(private readonly masterKey: string) {
    if (!masterKey || masterKey.length < 32) {
      throw new Error('Master key must be at least 32 characters long');
    }
  }

  async encrypt(text: string): Promise<EncryptedData> {
    if (!text) {
      return { encrypted: '', iv: '', salt: '' };
    }

    const salt = randomBytes(this.saltLength);
    const iv = randomBytes(this.ivLength);
    const key = (await scryptAsync(this.masterKey, salt, this.keyLength)) as Buffer;

    const cipher = createCipheriv(this.algorithm, key, iv);
    cipher.setAAD(Buffer.from('connector-account', 'utf8'));

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const tag = cipher.getAuthTag();

    return {
      encrypted: encrypted + tag.toString('hex'),
      iv: iv.toString('hex'),
      salt: salt.toString('hex'),
    };
  }

  async decrypt(encryptedData: EncryptedData): Promise<string> {
    if (!encryptedData.encrypted || !encryptedData.iv || !encryptedData.salt) {
      return '';
    }

    try {
      const salt = Buffer.from(encryptedData.salt, 'hex');
      const iv = Buffer.from(encryptedData.iv, 'hex');
      const key = (await scryptAsync(this.masterKey, salt, this.keyLength)) as Buffer;

      // Split encrypted data and tag
      const encryptedWithTag = encryptedData.encrypted;
      const encrypted = encryptedWithTag.slice(0, -32); // Remove last 32 hex chars (16 bytes)
      const tag = Buffer.from(encryptedWithTag.slice(-32), 'hex');

      const decipher = createDecipheriv(this.algorithm, key, iv);
      decipher.setAAD(Buffer.from('connector-account', 'utf8'));
      decipher.setAuthTag(tag);

      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      console.error('Decryption failed:', error);
      throw new Error('Failed to decrypt data');
    }
  }

  async encryptObject(obj: object): Promise<EncryptedData> {
    const jsonString = JSON.stringify(obj);
    return this.encrypt(jsonString);
  }

  async decryptObject<T = Record<string, unknown>>(encryptedData: EncryptedData): Promise<T> {
    const decryptedString = await this.decrypt(encryptedData);
    if (!decryptedString) {
      return {} as T;
    }
    return JSON.parse(decryptedString) as T;
  }
}

// Singleton instance
let encryptionService: EncryptionService | null = null;

export function getEncryptionService(): EncryptionService {
  if (!encryptionService) {
    const masterKey = process.env.ENCRYPTION_MASTER_KEY;
    if (!masterKey) {
      throw new Error('ENCRYPTION_MASTER_KEY environment variable is required');
    }
    encryptionService = new EncryptionService(masterKey);
  }
  return encryptionService;
}
