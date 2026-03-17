import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Minimal config service matching the server's ScratchConfigService interface.
 * Only exposes what the experimental backend needs.
 */
@Injectable()
export class ScratchConfigService {
  constructor(private readonly config: ConfigService) {}

  getDatabaseUrl(): string {
    return this.config.getOrThrow('DATABASE_URL');
  }

  getRedisHost(): string {
    return this.config.get('REDIS_HOST') ?? 'localhost';
  }

  getRedisPort(): number {
    return parseInt(this.config.get('REDIS_PORT') ?? '6379', 10);
  }

  getRedisPassword(): string | undefined {
    return this.config.get('REDIS_PASSWORD');
  }

  getRedisUrl(): string {
    return this.config.get('REDIS_URL') ?? `redis://${this.getRedisHost()}:${this.getRedisPort()}`;
  }

  getGitReposDir(): string {
    return this.config.getOrThrow('GIT_REPOS_DIR');
  }

  getScratchGitUrl(): string {
    return this.config.getOrThrow('SCRATCHMD_URL');
  }

  getAirtableApiKey(): string {
    return this.config.getOrThrow('AIRTABLE_API_KEY');
  }

  getAirtableTableIds(): string[] | undefined {
    const val = this.config.get('AIRTABLE_TABLE_IDS');
    if (!val) return undefined;
    return val.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  getWebflowApiKey(): string {
    return this.config.getOrThrow('WEBFLOW_API_KEY');
  }

  getWebflowCollectionIds(): string[] | undefined {
    const val = this.config.get('WEBFLOW_COLLECTION_IDS');
    if (!val) return undefined;
    return val.split(',').map((s: string) => s.trim()).filter(Boolean);
  }

  /** Generic escape hatch for env vars not covered by typed getters. */
  getOrThrow(key: string): string {
    return this.config.getOrThrow(key);
  }
}
