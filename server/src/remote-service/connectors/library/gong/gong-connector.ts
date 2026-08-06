/* eslint-disable @typescript-eslint/no-unused-vars -- pullRecordFiles/create/update/delete take interface-required params this read-only connector doesn't use (the write methods throw) */
import { connectorMetadata, TableView } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import {
  ConnectorInstantiationError,
  ErrorMessageTemplates,
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
import { GongApiClient, GongError } from './gong-api-client';
import { buildGongDefaultView, GongParsedTableId } from './gong-default-view';
import {
  buildGongCallsJsonTableSpec,
  buildGongLibraryFoldersJsonTableSpec,
  buildGongScorecardsJsonTableSpec,
  buildGongTranscriptsJsonTableSpec,
  buildGongUsersJsonTableSpec,
  buildGongWorkspacesJsonTableSpec,
  gongTableWsId,
} from './gong-json-schema';
import { GongEntityType, GongWorkspace, WORKSPACE_SCOPED_ENTITY_TYPES } from './gong-types';

/**
 * READ-ONLY connector for Gong (revenue intelligence / conversation analytics).
 *
 * Gong records and AI-analyzes sales conversations. The public API exposes the
 * analysis output — calls, transcripts, users, workspaces, library folders,
 * scorecard definitions — but offers NO update surface for any of them (its
 * only writes are call ingestion and CRM upload, which are integration
 * pipelines, not record edits). So every table is read-only: pull works,
 * create/update/delete throw.
 *
 * Calls, transcripts, library folders, and scorecards are workspace-scoped;
 * the workspace is a path segment (`/{Workspace}/Calls/...`). Users and
 * workspaces are company-wide and live at the root.
 *
 * Rate limits: 3 requests/second, 10,000/day per company (429 + Retry-After).
 * List pages cap at 100 records with an opaque cursor. Gong reports an empty
 * result set as HTTP 404 + an errors array — the API client maps that to an
 * empty list.
 */
export class GongConnector extends Connector {
  readonly service = Service.GONG;
  static readonly displayName = 'Gong';
  static readonly metadata = connectorMetadata({
    displayName: 'Gong',
    table: 'table',
    tables: 'tables',
    record: 'record',
    records: 'records',
    logo: 'https://static.scratch.md/connector-icons/gong.svg',
    visible: true,
    defaultAuthMethod: 'user_provided_params',
    credentialFields: {
      user_provided_params: [
        {
          key: 'gongAccessKey',
          type: 'string',
          label: 'Access Key',
          description: 'Created in Gong: company settings → Ecosystem → API',
          required: true,
        },
        {
          key: 'gongAccessKeySecret',
          type: 'password',
          label: 'Access Key Secret',
          required: true,
        },
        {
          key: 'gongBaseUrl',
          type: 'string',
          label: 'API Base URL',
          placeholder: 'https://us-12345.api.gong.io',
          description: "Your company's API base URL, shown on the same Gong API settings page",
          required: false,
        },
      ],
    },
  });

  private readonly client: GongApiClient;

  constructor(accessKey: string, accessKeySecret: string, baseUrl?: string, opts?: { rateLimiter?: RateLimiter }) {
    super();
    this.client = new GongApiClient(accessKey, accessKeySecret, baseUrl, opts);
  }

  async testConnection(): Promise<void> {
    await this.client.validateCredentials();
  }

  async listTables(): Promise<TablePreview[]> {
    const workspaces = await this.client.listWorkspaces();
    const readonlyFlags = {
      disabledCreates: true,
      disabledUpdates: true,
      disabledDeletes: true,
      disabledReason: 'Gong data is analysis output — the Gong API is read-only.',
    } as const;

    const company_wide_tables: TablePreview[] = [
      {
        id: { wsId: gongTableWsId(GongEntityType.USERS), remoteId: [GongEntityType.USERS] },
        displayName: 'Users',
        ...readonlyFlags,
        metadata: { description: 'Team members in your Gong company' },
      },
      {
        id: { wsId: gongTableWsId(GongEntityType.WORKSPACES), remoteId: [GongEntityType.WORKSPACES] },
        displayName: 'Workspaces',
        ...readonlyFlags,
        metadata: { description: 'Workspaces in your Gong company' },
      },
    ];

    const per_workspace_tables: TablePreview[] = workspaces.flatMap((workspace) => {
      const scoped = (entityType: GongEntityType, displayName: string, description: string): TablePreview => ({
        id: {
          wsId: gongTableWsId(entityType, workspace.id),
          remoteId: [entityType, workspace.id],
        },
        displayName,
        parentPath: workspace.name,
        ...readonlyFlags,
        metadata: { description },
      });
      return [
        scoped(GongEntityType.CALLS, 'Calls', 'Analyzed calls with participants, topics, trackers, and AI insights'),
        scoped(GongEntityType.TRANSCRIPTS, 'Call Transcripts', 'Full speaker-attributed transcripts, one per call'),
        scoped(GongEntityType.LIBRARY_FOLDERS, 'Library Folders', 'Call-library folder tree'),
        scoped(GongEntityType.SCORECARDS, 'Scorecards', 'Coaching scorecard definitions'),
      ];
    });

    return [...per_workspace_tables, ...company_wide_tables];
  }

  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    return buildGongDefaultView(spec, parseGongTableId(spec.id));
  }

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const parsed = parseGongTableId(id);

    switch (parsed.entityType) {
      case GongEntityType.USERS:
        return buildGongUsersJsonTableSpec(id);
      case GongEntityType.WORKSPACES:
        return buildGongWorkspacesJsonTableSpec(id);
      case GongEntityType.CALLS: {
        const workspace = await this.resolveWorkspace(parsed);
        return buildGongCallsJsonTableSpec(id, workspace.id, workspace.name);
      }
      case GongEntityType.TRANSCRIPTS: {
        const workspace = await this.resolveWorkspace(parsed);
        return buildGongTranscriptsJsonTableSpec(id, workspace.id, workspace.name);
      }
      case GongEntityType.LIBRARY_FOLDERS: {
        const workspace = await this.resolveWorkspace(parsed);
        return buildGongLibraryFoldersJsonTableSpec(id, workspace.id, workspace.name);
      }
      case GongEntityType.SCORECARDS: {
        const workspace = await this.resolveWorkspace(parsed);
        return buildGongScorecardsJsonTableSpec(id, workspace.id, workspace.name);
      }
      default:
        throw new GongError(`Unknown Gong table '${id.wsId}'`, 404);
    }
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    progress: JsonSafeObject,
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const parsed = parseGongTableId(tableSpec.id);
    const resume_cursor = (progress as { nextCursor?: string })?.nextCursor;

    switch (parsed.entityType) {
      case GongEntityType.USERS: {
        for await (const { items, nextCursor } of this.client.listUsers(resume_cursor)) {
          await callback({
            files: items as unknown as ConnectorFile[],
            connectorProgress: nextCursor ? { nextCursor } : {},
          });
        }
        break;
      }

      case GongEntityType.WORKSPACES: {
        const workspaces = await this.client.listWorkspaces();
        await callback({ files: workspaces as unknown as ConnectorFile[] });
        break;
      }

      case GongEntityType.CALLS: {
        const workspaceId = requireWorkspaceId(parsed);
        for await (const { items, nextCursor } of this.client.listCallsExtensive(workspaceId, resume_cursor)) {
          await callback({
            files: items as unknown as ConnectorFile[],
            connectorProgress: nextCursor ? { nextCursor } : {},
          });
        }
        break;
      }

      case GongEntityType.TRANSCRIPTS: {
        const workspaceId = requireWorkspaceId(parsed);
        for await (const { items, nextCursor } of this.client.listCallTranscripts(workspaceId, resume_cursor)) {
          await callback({
            files: items as unknown as ConnectorFile[],
            connectorProgress: nextCursor ? { nextCursor } : {},
          });
        }
        break;
      }

      case GongEntityType.LIBRARY_FOLDERS: {
        const workspaceId = requireWorkspaceId(parsed);
        const folders = await this.client.listLibraryFolders(workspaceId);
        await callback({ files: folders as unknown as ConnectorFile[] });
        break;
      }

      case GongEntityType.SCORECARDS: {
        const workspaceId = requireWorkspaceId(parsed);
        const all_company_scorecards = await this.client.listScorecards();
        const scorecards_in_this_workspace = all_company_scorecards.filter(
          (scorecard) => scorecard.workspaceId === workspaceId,
        );
        await callback({ files: scorecards_in_this_workspace as unknown as ConnectorFile[] });
        break;
      }

      default:
        throw new GongError(`Unknown Gong table '${tableSpec.id.wsId}'`, 404);
    }
    return {};
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const parsed = parseGongTableId(tableSpec.id);

    switch (parsed.entityType) {
      case GongEntityType.USERS: {
        const users: ConnectorFile[] = [];
        for (const id of ids) {
          const user = await this.client.getUser(id);
          if (user) users.push(user as unknown as ConnectorFile);
        }
        if (users.length > 0) await callback({ files: users });
        break;
      }

      case GongEntityType.WORKSPACES: {
        const wanted_ids = new Set(ids);
        const workspaces = (await this.client.listWorkspaces()).filter((workspace) => wanted_ids.has(workspace.id));
        if (workspaces.length > 0) await callback({ files: workspaces as unknown as ConnectorFile[] });
        break;
      }

      case GongEntityType.CALLS: {
        const calls = await this.client.listCallsExtensiveByIds(ids);
        if (calls.length > 0) await callback({ files: calls as unknown as ConnectorFile[] });
        break;
      }

      case GongEntityType.TRANSCRIPTS: {
        const transcripts = await this.client.listCallTranscriptsByCallIds(ids);
        if (transcripts.length > 0) await callback({ files: transcripts as unknown as ConnectorFile[] });
        break;
      }

      case GongEntityType.LIBRARY_FOLDERS: {
        const workspaceId = requireWorkspaceId(parsed);
        const wanted_ids = new Set(ids);
        const folders = (await this.client.listLibraryFolders(workspaceId)).filter((folder) =>
          wanted_ids.has(folder.id),
        );
        if (folders.length > 0) await callback({ files: folders as unknown as ConnectorFile[] });
        break;
      }

      case GongEntityType.SCORECARDS: {
        const wanted_ids = new Set(ids);
        const scorecards = (await this.client.listScorecards()).filter((scorecard) =>
          wanted_ids.has(scorecard.scorecardId),
        );
        if (scorecards.length > 0) await callback({ files: scorecards as unknown as ConnectorFile[] });
        break;
      }

      default:
        throw new GongError(`Unknown Gong table '${tableSpec.id.wsId}'`, 404);
    }
  }

  getBatchSize(): number {
    // Writes are unsupported (see below), but the contract requires a positive number.
    return 1;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createRecords(tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<ConnectorFile[]> {
    throw this.readOnlyError('create', tableSpec);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    _files: ConnectorFile[],
    _changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    throw this.readOnlyError('update', tableSpec);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async deleteRecords(tableSpec: BaseJsonTableSpec, _files: ConnectorFile[]): Promise<void> {
    throw this.readOnlyError('delete', tableSpec);
  }

  private readOnlyError(operation: 'create' | 'update' | 'delete', tableSpec: BaseJsonTableSpec): GongError {
    return new GongError(
      `Gong is a read-only connector: cannot ${operation} records in '${tableSpec.name}'. ` +
        'The Gong API does not support editing analyzed conversation data.',
    );
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    const parsed = parseGongTableId(tableSpec.id);
    switch (parsed.entityType) {
      case GongEntityType.CALLS:
        return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'metaData.title');
      case GongEntityType.USERS:
        return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'emailAddress');
      case GongEntityType.TRANSCRIPTS:
        // No human-friendly name on a transcript — fall back to the call id.
        return records.map(() => undefined);
      case GongEntityType.SCORECARDS:
        return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'scorecardName');
      default:
        return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, 'name');
    }
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof GongError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: { status: error.statusCode, responseData: error.responseData },
      };
    }

    if (isAxiosError(error)) {
      const status = error.response?.status;
      if (status === 401 || status === 403) {
        return { userFriendlyMessage: ErrorMessageTemplates.API_UNAUTHORIZED('Gong') };
      }
      if (status === 429) {
        return { userFriendlyMessage: ErrorMessageTemplates.API_QUOTA_EXCEEDED('Gong') };
      }

      const common = extractCommonDetailsFromAxiosError(this, error);
      if (common) return common;

      return {
        userFriendlyMessage: extractErrorMessageFromAxiosError(this.service, error, ['errors', 'message']),
        description: error.message,
        additionalContext: { status },
      };
    }

    return this.fallbackErrorDetails(error);
  }

  /** Resolve a workspace-scoped table's workspace (for path names); throws if it vanished. */
  private async resolveWorkspace(parsed: GongParsedTableId): Promise<GongWorkspace> {
    const workspaceId = requireWorkspaceId(parsed);
    const workspace = (await this.client.listWorkspaces()).find((candidate) => candidate.id === workspaceId);
    if (!workspace) {
      throw new GongError(`Gong workspace ${workspaceId} was not found (was it deleted?)`, 404);
    }
    return workspace;
  }
}

/** Parse a table's EntityId back into entity type + workspace scope (mirrors listTables). */
export function parseGongTableId(id: EntityId): GongParsedTableId {
  const entityType = id.remoteId[0] as GongEntityType;
  if (!Object.values(GongEntityType).includes(entityType)) {
    throw new GongError(`Invalid Gong table id: ${JSON.stringify(id.remoteId)}`, 404);
  }
  if (WORKSPACE_SCOPED_ENTITY_TYPES.has(entityType)) {
    const workspaceId = id.remoteId[1];
    if (!workspaceId) {
      throw new GongError(`Gong table '${entityType}' is missing its workspace id`, 404);
    }
    return { entityType, workspaceId };
  }
  return { entityType };
}

function requireWorkspaceId(parsed: GongParsedTableId): string {
  if (!parsed.workspaceId) {
    throw new GongError(`Gong table '${parsed.entityType}' is missing its workspace id`, 404);
  }
  return parsed.workspaceId;
}

connectorRegistry.register({
  service: Service.GONG,
  metadata: GongConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  // Gong allows 3 requests/second per company (plus a 10k/day quota).
  rateLimiterSpec: { points: 3, duration: 1 },
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    const accessKey = ctx.decryptedCredentials?.gongAccessKey;
    const accessKeySecret = ctx.decryptedCredentials?.gongAccessKeySecret;
    if (!accessKey || !accessKeySecret) {
      throw new ConnectorInstantiationError('Access key and secret are required for Gong', Service.GONG);
    }
    const rateLimiter = ctx.connectorAccount ? ctx.createRateLimiter(ctx.connectorAccount.id) : undefined;
    return new GongConnector(accessKey, accessKeySecret, ctx.decryptedCredentials?.gongBaseUrl, { rateLimiter });
  },
});
