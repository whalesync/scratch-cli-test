import { connectorMetadata } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { randomUUID } from 'crypto';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  extractCommonDetailsFromAxiosError,
  extractErrorMessageFromAxiosError,
} from '../../error';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  EntityId,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  TablePreview,
} from '../../types';
import { MemberstackApiClient, MemberstackError } from './memberstack-api-client';
import { buildMemberstackJsonTableSpec } from './memberstack-json-schema';

/**
 * Connector for the Memberstack membership platform.
 *
 * Syncs members from a Memberstack app via the Admin REST API.
 * Single table: Members. Full CRUD support.
 *
 * API docs: https://developers.memberstack.com/admin-rest-api/member-actions
 */
export class MemberstackConnector extends Connector {
  readonly service = Service.MEMBERSTACK;
  static readonly displayName = 'Memberstack';
  static readonly metadata = connectorMetadata({
    displayName: 'Memberstack',
    table: 'table',
    tables: 'tables',
    record: 'member',
    records: 'members',
    logo: 'https://static.scratch.md/connector-icons/memberstack.svg',
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'Secret API Key',
          placeholder: 'sk_... or sk_sb_...',
          required: true,
        },
      ],
    },
  });

  private readonly client: MemberstackApiClient;

  constructor(apiKey: string) {
    super();
    this.client = new MemberstackApiClient(apiKey);
  }

  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return [
      {
        id: {
          wsId: 'members',
          remoteId: ['members'],
        },
        displayName: 'Members',
        metadata: {
          description: 'Members in your Memberstack app',
        },
      },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    if (id.wsId !== 'members' || !id.remoteId.includes('members')) {
      throw new MemberstackError(`Table '${id.wsId}' not found. Memberstack only supports the 'Members' table.`, 404);
    }
    return buildMemberstackJsonTableSpec(id);
  }

  async pullRecordFiles(
    _tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const resumeCursor = (progress as { endCursor?: string })?.endCursor ?? undefined;

    for await (const batch of this.client.listMembers(200, resumeCursor)) {
      await callback({
        files: batch.data as unknown as ConnectorFile[],
        connectorProgress: batch.endCursor ? { endCursor: batch.endCursor } : {},
      });
    }
    return {};
  }

  async pullRecordFilesByIds(
    _tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      const member = await this.client.getMember(id);
      if (member) {
        buffer.push(member as unknown as ConnectorFile);
      }

      if (buffer.length >= BATCH_SIZE) {
        await callback({ files: buffer.splice(0) });
      }
    }

    if (buffer.length > 0) {
      await callback({ files: buffer });
    }
  }

  getBatchSize(): number {
    return 10;
  }

  async createRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const results: ConnectorFile[] = [];

    for (const file of files) {
      const created = await this.client.createMember({
        email: (file.auth as { email: string })?.email ?? (file.email as string),
        password: randomUUID(),
        customFields: file.customFields as Record<string, string> | undefined,
        metaData: file.metaData as Record<string, unknown> | undefined,
        json: file.json as Record<string, unknown> | undefined,
        loginRedirect: file.loginRedirect as string | undefined,
      });
      results.push(created as unknown as ConnectorFile);
    }

    return results;
  }

  async updateRecords(
    _tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<void> {
    for (let i = 0; i < files.length; i++) {
      const memberId = files[i].id as string;
      const changed = changedFields[i];
      await this.client.updateMember(memberId, {
        email: (changed.auth as { email?: string } | undefined)?.email,
        customFields: changed.customFields as Record<string, string> | undefined,
        metaData: changed.metaData as Record<string, unknown> | undefined,
        json: changed.json as Record<string, unknown> | undefined,
        loginRedirect: changed.loginRedirect as string | undefined,
      });
    }
  }

  async deleteRecords(_tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    for (const file of files) {
      const memberId = file.id as string;
      if (memberId) {
        await this.client.deleteMember(memberId);
      }
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath, 'auth.email');
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof MemberstackError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: {
          status: error.statusCode,
          responseData: error.responseData,
        },
      };
    }

    if (isAxiosError(error)) {
      const commonError = extractCommonDetailsFromAxiosError(this, error);
      if (commonError) return commonError;

      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['message', 'error']),
        description: error.message,
        additionalContext: {
          status: error.response?.status,
        },
      };
    }

    return this.fallbackErrorDetails(error);
  }
}

connectorRegistry.register({
  service: Service.MEMBERSTACK,
  metadata: MemberstackConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  rateLimiterSpec: { points: 25, duration: 1 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Memberstack', Service.MEMBERSTACK);
    }
    if (!ctx.decryptedCredentials?.apiKey) {
      throw new ConnectorInstantiationError('API key is required for Memberstack', Service.MEMBERSTACK);
    }
    return new MemberstackConnector(ctx.decryptedCredentials.apiKey);
  },
});
