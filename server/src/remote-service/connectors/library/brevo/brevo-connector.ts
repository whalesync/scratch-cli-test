import { connectorMetadata } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  extractCommonDetailsFromAxiosError,
  extractErrorMessageFromAxiosError,
  ReadonlyFieldEditError,
  readonlyFieldEditErrorMessage,
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

/** Record-level fields Brevo accepts on a contact UPDATE (email is the identity, read-only here). */
const CONTACT_WRITABLE_UPDATE_KEYS = new Set(['attributes', 'emailBlacklisted', 'smsBlacklisted', 'listIds']);

/** Record-level fields Brevo accepts on a template UPDATE (`name` maps to templateName). */
const TEMPLATE_WRITABLE_UPDATE_KEYS = new Set([
  'name',
  'subject',
  'sender',
  'htmlContent',
  'isActive',
  'replyTo',
  'toField',
  'tag',
]);

/**
 * Throw if the user's sparse changed fields include a field Brevo can't update
 * (DEV-10597). The keys here are only what the user changed, so a non-writable
 * key is a genuine read-only edit that must be surfaced rather than silently
 * dropped from the cherry-picked update payload. `id` is the identity, ignored.
 */
function assertOnlyWritableBrevoFieldsChanged(changed: Record<string, unknown>, writableKeys: Set<string>): void {
  const readonlyChangedFieldNames: string[] = [];
  for (const key of Object.keys(changed)) {
    if (key === 'id') continue;
    if (!writableKeys.has(key)) readonlyChangedFieldNames.push(key);
  }
  if (readonlyChangedFieldNames.length > 0) {
    throw new ReadonlyFieldEditError(readonlyFieldEditErrorMessage(readonlyChangedFieldNames));
  }
}

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

  constructor(apiKey: string, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new BrevoApiClient(apiKey, { rateLimiter: opts?.rateLimiter });
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
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
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
    return {};
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
  ): Promise<ConnectorFile[]> {
    const results: ConnectorFile[] = new Array<ConnectorFile>(files.length);

    // Phase 1: writes. Brevo's update endpoints return 204 No Content (no
    // echo), so the response carries no information — we just fire-and-await
    // for side effects.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const changed = changedFields[i];
      if (tableSpec.id.wsId === 'contacts') {
        // A changed field outside Brevo's updatable contact set (email is the
        // identity; createdAt/modifiedAt are computed) is a genuine read-only
        // edit — surface it instead of silently dropping it (DEV-10597).
        assertOnlyWritableBrevoFieldsChanged(changed, CONTACT_WRITABLE_UPDATE_KEYS);
        const contactId = file.id as number;
        const data: BrevoUpdateContactRequest = {
          attributes: changed.attributes as Record<string, unknown> | undefined,
          emailBlacklisted: changed.emailBlacklisted as boolean | undefined,
          smsBlacklisted: changed.smsBlacklisted as boolean | undefined,
          listIds: changed.listIds as number[] | undefined,
        };
        await this.client.updateContact(contactId, data);
      } else if (tableSpec.id.wsId === 'templates') {
        assertOnlyWritableBrevoFieldsChanged(changed, TEMPLATE_WRITABLE_UPDATE_KEYS);
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

    // Phase 2: refetch. Mirror `pullRecordFilesByIds` (line 178) so the
    // returned ConnectorFile is byte-equal to a fresh pull — Brevo's update
    // endpoints return no body, so the only way to know what was persisted
    // is to GET it back. Per-record because Brevo has no bulk-read endpoint.
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      let refetched: unknown = null;
      if (tableSpec.id.wsId === 'contacts') {
        refetched = await this.client.getContact(file.id as number);
      } else if (tableSpec.id.wsId === 'templates') {
        refetched = await this.client.getTemplate(file.id as number);
      }
      // Record disappeared between write and refetch, or table type doesn't
      // support refetch. Fall back to the input file; the dispatch-site
      // identity assertion catches cross-row misalignment.
      results[i] = (refetched as ConnectorFile | null) ?? file;
    }

    return results;
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
      return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'email');
    }
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'name');
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
  // Brevo's limits are per endpoint GROUP, which a single bucket cannot express.
  // 8/s sits just under the 10 requests/second that `/v3/contacts/…` allows —
  // covering Contacts and Mailing Lists, the two highest-volume tables.
  //
  // Templates are the exception and are knowingly under-modelled: `/v3/smtp/…`
  // (other than sending) is capped at **300 requests/HOUR**, which no per-second
  // bucket can approximate. Rather than throttle Contacts to 1 request per 12
  // seconds to suit the smallest table, we let Templates hit 429 and rely on the
  // retry policy to back off — `x-sib-ratelimit-reset` tells us exactly how long
  // to wait, so the pull slows down instead of failing.
  // https://developers.brevo.com/docs/api-limits
  rateLimiterSpec: { points: 8, duration: 1 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Brevo', Service.BREVO);
    }
    if (!ctx.decryptedCredentials?.apiKey) {
      throw new ConnectorInstantiationError('API key is required for Brevo', Service.BREVO);
    }
    return new BrevoConnector(ctx.decryptedCredentials.apiKey, {
      rateLimiter: ctx.createRateLimiter(ctx.connectorAccount.id),
    });
  },
});
