import { connectorMetadata, DataFolderOptions } from '@spinner/shared-types';
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
import { BrevoApiClient, BrevoError } from './brevo-api-client';
import {
  buildBrevoContactsJsonTableSpec,
  buildBrevoMailingListsJsonTableSpec,
  buildBrevoTemplatesJsonTableSpec,
} from './brevo-json-schema';
import { BrevoCreateContactRequest, BrevoCreateTemplateRequest, BrevoUpdateContactRequest } from './brevo-types';

/**
 * Connector for the Brevo email marketing platform.
 *
 * Syncs contacts, email templates, and mailing lists via the Brevo v3 REST API.
 * Three tables: Contacts (dynamic schema, full CRUD), Email Templates (static schema, full CRUD),
 * and Mailing Lists (static schema, read-only).
 *
 * API docs: https://developers.brevo.com/reference
 */
export class BrevoConnector extends Connector {
  readonly service = Service.BREVO;
  static readonly displayName = 'Brevo';
  static readonly metadata = connectorMetadata({
    displayName: 'Brevo',
    table: 'resource',
    tables: 'resources',
    record: 'record',
    records: 'records',
    logo: 'https://static.scratch.md/connector-icons/brevo.svg',
    credentialFields: {
      user_provided_params: [
        {
          key: 'apiKey',
          type: 'password',
          label: 'API Key',
          placeholder: 'xkeysib-...',
          required: true,
        },
      ],
    },
  });

  private readonly client: BrevoApiClient;

  constructor(apiKey: string) {
    super();
    this.client = new BrevoApiClient(apiKey);
  }

  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async listTables(): Promise<TablePreview[]> {
    return [
      {
        id: { wsId: 'contacts', remoteId: ['contacts'] },
        displayName: 'Contacts',
        metadata: { description: 'Contacts in your Brevo account' },
      },
      {
        id: { wsId: 'templates', remoteId: ['templates'] },
        displayName: 'Email Templates',
        metadata: { description: 'Email templates in your Brevo account' },
      },
      {
        id: { wsId: 'mailing_lists', remoteId: ['mailing_lists'] },
        displayName: 'Mailing Lists',
        disabledCreates: true,
        disabledUpdates: true,
        disabledDeletes: true,
        metadata: { description: 'Mailing lists in your Brevo account (read-only)' },
      },
    ];
  }

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    switch (id.wsId) {
      case 'contacts': {
        const attributes = await this.client.getContactAttributes();
        return buildBrevoContactsJsonTableSpec(id, attributes);
      }
      case 'templates':
        return buildBrevoTemplatesJsonTableSpec(id);
      case 'mailing_lists':
        return buildBrevoMailingListsJsonTableSpec(id);
      default:
        throw new BrevoError(`Unknown table '${id.wsId}'.`, 404);
    }
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: DataFolderOptions,
  ): Promise<void> {
    const resumeOffset = (progress as { nextOffset?: number })?.nextOffset ?? 0;

    switch (tableSpec.id.wsId) {
      case 'contacts': {
        let offset = resumeOffset;
        for await (const contacts of this.client.listContacts(1000, resumeOffset)) {
          offset += contacts.length;
          await callback({
            files: contacts as unknown as ConnectorFile[],
            connectorProgress: { nextOffset: offset },
          });
        }
        break;
      }

      case 'templates': {
        // The list endpoint may not include htmlContent, so we fetch each template individually.
        let offset = resumeOffset;
        for await (const templatePage of this.client.listTemplates(1000, resumeOffset)) {
          const fullTemplates: ConnectorFile[] = [];
          for (const template of templatePage) {
            const full = await this.client.getTemplate(template.id);
            if (full) {
              fullTemplates.push(full as unknown as ConnectorFile);
            }
          }
          offset += templatePage.length;
          if (fullTemplates.length > 0) {
            await callback({ files: fullTemplates, connectorProgress: { nextOffset: offset } });
          }
        }
        break;
      }

      case 'mailing_lists': {
        let offset = resumeOffset;
        for await (const lists of this.client.listMailingLists(50, resumeOffset)) {
          offset += lists.length;
          await callback({
            files: lists as unknown as ConnectorFile[],
            connectorProgress: { nextOffset: offset },
          });
        }
        break;
      }

      default:
        throw new BrevoError(`Unknown table '${tableSpec.id.wsId}'`, 404);
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
      if (tableSpec.id.wsId === 'contacts') {
        record = await this.client.getContact(id);
      } else if (tableSpec.id.wsId === 'templates') {
        record = await this.client.getTemplate(Number(id));
      } else if (tableSpec.id.wsId === 'mailing_lists') {
        record = await this.client.getMailingList(Number(id));
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
      if (tableSpec.id.wsId === 'contacts') {
        const data: BrevoCreateContactRequest = {
          email: file.email as string,
          attributes: file.attributes as Record<string, unknown> | undefined,
          emailBlacklisted: file.emailBlacklisted as boolean | undefined,
          smsBlacklisted: file.smsBlacklisted as boolean | undefined,
          listIds: file.listIds as number[] | undefined,
        };
        const created = await this.client.createContact(data);
        results.push(created as unknown as ConnectorFile);
      } else if (tableSpec.id.wsId === 'templates') {
        const data: BrevoCreateTemplateRequest = {
          templateName: file.name as string,
          subject: file.subject as string,
          sender: (file.sender as { name?: string; email?: string; id?: number }) ?? {},
          htmlContent: file.htmlContent as string | undefined,
          isActive: file.isActive as boolean | undefined,
          replyTo: file.replyTo as string | undefined,
          toField: file.toField as string | undefined,
          tag: file.tag as string | undefined,
        };
        const created = await this.client.createTemplate(data);
        results.push(created as unknown as ConnectorFile);
      }
    }

    return results;
  }

  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<void> {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const changed = changedFields[i];
      if (tableSpec.id.wsId === 'contacts') {
        const contactId = file.id as number;
        const data: BrevoUpdateContactRequest = {
          attributes: changed.attributes as Record<string, unknown> | undefined,
          emailBlacklisted: changed.emailBlacklisted as boolean | undefined,
          smsBlacklisted: changed.smsBlacklisted as boolean | undefined,
          listIds: changed.listIds as number[] | undefined,
        };
        await this.client.updateContact(contactId, data);
      } else if (tableSpec.id.wsId === 'templates') {
        const templateId = file.id as number;
        await this.client.updateTemplate(templateId, {
          templateName: changed.name as string | undefined,
          subject: changed.subject as string | undefined,
          sender: changed.sender as { name?: string; email?: string; id?: number } | undefined,
          htmlContent: changed.htmlContent as string | undefined,
          isActive: changed.isActive as boolean | undefined,
          replyTo: changed.replyTo as string | undefined,
          toField: changed.toField as string | undefined,
          tag: changed.tag as string | undefined,
        });
      }
    }
  }

  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    for (const file of files) {
      if (tableSpec.id.wsId === 'contacts') {
        const contactId = file.id as number;
        if (contactId) {
          await this.client.deleteContact(contactId);
        }
      } else if (tableSpec.id.wsId === 'templates') {
        const templateId = file.id as number;
        if (templateId) {
          await this.client.deleteTemplate(templateId);
        }
      }
    }
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    if (tableSpec.id.wsId === 'contacts') {
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath, 'email');
    }
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugFieldPath, 'name');
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof BrevoError) {
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
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['message', 'code']),
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
  service: Service.BREVO,
  metadata: BrevoConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  rateLimiterSpec: { points: 8, duration: 1 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Brevo', Service.BREVO);
    }
    if (!ctx.decryptedCredentials?.apiKey) {
      throw new ConnectorInstantiationError('API key is required for Brevo', Service.BREVO);
    }
    return new BrevoConnector(ctx.decryptedCredentials.apiKey);
  },
});
