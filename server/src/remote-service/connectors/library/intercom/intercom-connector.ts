import { connectorMetadata, ConnectorSettingDefinition, DataFolderOptions } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  extractCommonDetailsFromAxiosError,
  extractErrorMessageFromAxiosError,
} from '../../error';
import { Service } from '../../service-constants';
import { BaseJsonTableSpec, ConnectorErrorDetails, ConnectorFile, EntityId, TablePreview } from '../../types';
import { IntercomApiClient, IntercomError } from './intercom-api-client';
import {
  buildIntercomArticlesJsonTableSpec,
  buildIntercomCollectionsJsonTableSpec,
  buildIntercomConversationsJsonTableSpec,
} from './intercom-json-schema';
import {
  IntercomCreateArticleRequest,
  IntercomCreateCollectionRequest,
  IntercomUpdateArticleRequest,
  IntercomUpdateCollectionRequest,
} from './intercom-types';

interface IntercomPullOptions extends DataFolderOptions {
  excludeConversationParts?: boolean | undefined;
}

/**
 * Connector for the Intercom customer messaging platform.
 *
 * Syncs Help Center articles and collections via the Intercom REST API.
 * Two tables: Articles (full CRUD) and Collections (full CRUD).
 *
 * API docs: https://developers.intercom.com/docs/references/rest-api/api.intercom.io/
 */
export class IntercomConnector extends Connector {
  readonly service = Service.INTERCOM;
  static readonly displayName = 'Intercom';
  static readonly metadata = connectorMetadata({
    displayName: 'Intercom',
    table: 'resource',
    tables: 'resources',
    record: 'record',
    records: 'records',
    logo: 'https://static.scratch.md/connector-icons/intercom.svg',
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'Access Token',
          placeholder: 'dG9rOjEyM...',
          description: 'Create an access token in your Intercom Developer Hub app settings',
          required: true,
        },
      ],
    },
  });

  static readonly advancedSettings: ConnectorSettingDefinition[] = [
    {
      key: 'excludeConversationParts',
      type: 'boolean',
      label: 'Exclude conversation replies',
      description:
        'Skip downloading threaded replies and notes for conversations. Significantly increases download speed for large workspaces.',
    },
  ];

  private readonly client: IntercomApiClient;

  constructor(accessToken: string) {
    super();
    this.client = new IntercomApiClient(accessToken);
  }

  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return [
      {
        id: { wsId: 'articles', remoteId: ['articles'] },
        displayName: 'Articles',
        metadata: { description: 'Help Center articles in your Intercom workspace' },
      },
      {
        id: { wsId: 'collections', remoteId: ['collections'] },
        displayName: 'Collections',
        metadata: { description: 'Help Center collections in your Intercom workspace' },
      },
      {
        id: { wsId: 'conversations', remoteId: ['conversations'] },
        displayName: 'Conversations',
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
        metadata: { description: 'Conversations in your Intercom workspace (read-only)' },
      },
    ];
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    switch (id.wsId) {
      case 'articles':
        return buildIntercomArticlesJsonTableSpec(id);
      case 'collections':
        return buildIntercomCollectionsJsonTableSpec(id);
      case 'conversations':
        return buildIntercomConversationsJsonTableSpec(id);
      default:
        throw new IntercomError(`Unknown table '${id.wsId}'.`, 404);
    }
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    options: IntercomPullOptions,
  ): Promise<void> {
    const resumeProgress = progress as { nextPage?: number; startingAfter?: string };

    switch (tableSpec.id.wsId) {
      case 'articles': {
        let page = resumeProgress?.nextPage ?? 1;
        for await (const articles of this.client.listArticles(25, page)) {
          page++;
          await callback({ files: articles as unknown as ConnectorFile[], connectorProgress: { nextPage: page } });
        }
        break;
      }

      case 'collections': {
        let page = resumeProgress?.nextPage ?? 1;
        for await (const collections of this.client.listCollections(20, page)) {
          page++;
          await callback({ files: collections as unknown as ConnectorFile[], connectorProgress: { nextPage: page } });
        }
        break;
      }

      case 'conversations': {
        const hydrate = !options.excludeConversationParts;
        for await (const conversations of this.client.listConversations(20, hydrate, resumeProgress?.startingAfter)) {
          const lastConvo = conversations[conversations.length - 1];
          const lastId = lastConvo ? String((lastConvo as Record<string, unknown>).id) : undefined;
          await callback({
            files: conversations as unknown as ConnectorFile[],
            connectorProgress: lastId ? { startingAfter: lastId } : {},
          });
        }
        break;
      }

      default:
        throw new IntercomError(`Unknown table '${tableSpec.id.wsId}'`, 404);
    }
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const BATCH_SIZE = 20;
    const buffer: ConnectorFile[] = [];

    for (const id of ids) {
      let record: unknown = null;
      if (tableSpec.id.wsId === 'articles') {
        record = await this.client.getArticle(id);
      } else if (tableSpec.id.wsId === 'collections') {
        record = await this.client.getCollection(id);
      } else if (tableSpec.id.wsId === 'conversations') {
        record = await this.client.getConversation(id);
      }

      if (record) {
        buffer.push(record as ConnectorFile);
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

  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const results: ConnectorFile[] = [];

    for (const file of files) {
      if (tableSpec.id.wsId === 'articles') {
        const data: IntercomCreateArticleRequest = {
          title: file.title as string,
          author_id: file.author_id as number,
          description: file.description as string | undefined,
          body: file.body as string | undefined,
          state: file.state as 'published' | 'draft' | undefined,
          parent_id: file.parent_id as number | undefined,
          parent_type: file.parent_type as 'collection' | 'section' | undefined,
          translated_content: file.translated_content as Record<string, unknown> | undefined,
        };
        const created = await this.client.createArticle(data);
        results.push(created as unknown as ConnectorFile);
      } else if (tableSpec.id.wsId === 'collections') {
        const data: IntercomCreateCollectionRequest = {
          name: file.name as string,
          description: file.description as string | undefined,
          translated_content: file.translated_content as Record<string, unknown> | undefined,
          icon: file.icon as string | undefined,
          parent_id: file.parent_id as string | undefined,
          help_center_id: file.help_center_id as number | undefined,
        };
        const created = await this.client.createCollection(data);
        results.push(created as unknown as ConnectorFile);
      }
    }

    return results;
  }

  async updateRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    for (const file of files) {
      if (tableSpec.id.wsId === 'articles') {
        const articleId = file.id as string;
        const data: IntercomUpdateArticleRequest = {
          title: file.title as string | undefined,
          description: file.description as string | undefined,
          body: file.body as string | undefined,
          author_id: file.author_id as number | undefined,
          state: file.state as 'published' | 'draft' | undefined,
          parent_id: file.parent_id as number | undefined,
          parent_type: file.parent_type as 'collection' | 'section' | undefined,
          translated_content: file.translated_content as Record<string, unknown> | undefined,
        };
        await this.client.updateArticle(articleId, data);
      } else if (tableSpec.id.wsId === 'collections') {
        const collectionId = file.id as string;
        const data: IntercomUpdateCollectionRequest = {
          name: file.name as string | undefined,
          description: file.description as string | undefined,
          translated_content: file.translated_content as Record<string, unknown> | undefined,
          icon: file.icon as string | undefined,
          parent_id: file.parent_id as string | undefined,
          help_center_id: file.help_center_id as number | undefined,
        };
        await this.client.updateCollection(collectionId, data);
      }
    }
  }

  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    for (const file of files) {
      const recordId = file.id as string;
      if (!recordId) continue;

      if (tableSpec.id.wsId === 'articles') {
        await this.client.deleteArticle(recordId);
      } else if (tableSpec.id.wsId === 'collections') {
        await this.client.deleteCollection(recordId);
      }
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    if (tableSpec.id.wsId === 'articles') {
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath, 'title');
    }
    if (tableSpec.id.wsId === 'conversations') {
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath, 'source.subject', 'title');
    }
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath, 'name');
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof IntercomError) {
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
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, [
          'message',
          'errors',
          'error_code',
        ]),
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
  service: Service.INTERCOM,
  metadata: IntercomConnector.metadata,
  advancedSettings: IntercomConnector.advancedSettings,
  supportedAuthMethods: ['user_provided_params'],
  rateLimiterSpec: { points: 150, duration: 1 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Intercom', Service.INTERCOM);
    }
    if (!ctx.decryptedCredentials?.apiKey) {
      throw new ConnectorInstantiationError('Access token is required for Intercom', Service.INTERCOM);
    }
    return new IntercomConnector(ctx.decryptedCredentials.apiKey);
  },
});
