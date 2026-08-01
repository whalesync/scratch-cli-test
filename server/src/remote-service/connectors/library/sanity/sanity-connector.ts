import { connectorMetadata, IncrementalPullSupport, TableView } from '@spinner/shared-types';
import { isAxiosError } from 'axios';
import { WSLogger } from 'src/logger';
import { RateLimiter } from 'src/rate-limiter/rate-limiter';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import { ConnectorInstantiationError, extractCommonDetailsFromAxiosError } from '../../error';
import { sanitizeForTableWsId } from '../../ids';
import { Service } from '../../service-constants';
import {
  BaseJsonTableSpec,
  ConnectorErrorDetails,
  ConnectorFile,
  EntityId,
  PullRecordFilesOptions,
  PullRecordFilesResult,
  readRecordIdAsString,
  TablePreview,
} from '../../types';
import { SanityApiClient, SanityError } from './sanity-api-client';
import { buildSanityDefaultView } from './sanity-default-view';
import { parseDeployedSchemaEnrichmentsByTypeName, SanityDeployedTypeEnrichment } from './sanity-deployed-schema';
import { buildSanityIncrementalSinceParam } from './sanity-incremental';
import {
  buildSanityJsonTableSpec,
  collectReferenceFieldSampleRefIds,
  SANITY_SCHEMA_INFERENCE_SAMPLE_SIZE,
} from './sanity-json-schema';
import { SanityDocument, SanityMutation } from './sanity-types';

/**
 * Connector for Sanity (sanity.io) — a headless CMS whose backend ("Content Lake") is a
 * schemaless JSON document store.
 *
 * Model mapping: a dataset holds documents, each tagged with a user-defined `_type`.
 * Each `_type` becomes a Scratch table; the dataset is a path segment (`basePath`), since
 * a project can have several datasets. The project itself is connection scope — robot
 * tokens are project-scoped, and the connector auto-discovers the project from the token.
 *
 * Reads are GROQ queries over the `published` perspective (drafts excluded); writes go
 * through the transactional Mutation API.
 */

/**
 * Sanity's own internal document types are not user content tables. Two reserved
 * namespaces observed live: `sanity.*` (imageAsset, fileAsset, workspace.schema, …)
 * and `system.*` (system.group, system.retention — present even in a fresh project).
 */
const SANITY_INTERNAL_TYPE_NAME_PREFIXES = ['sanity.', 'system.'];

/** Page size for pulls — well under the API's response-size limits. */
const SANITY_PULL_PAGE_SIZE = 100;

/**
 * Mutations are capped at 25 req/s and a 4 MB body; 25 documents per transaction keeps
 * both comfortable while still batching.
 */
const SANITY_MUTATION_BATCH_SIZE = 25;

type SanityPullProgress = JsonSafeObject & { lastPulledDocumentId?: string };

/** The `remoteId` layout every Sanity `EntityId` uses: `[projectId, dataset, type]`. */
function parseSanityTableRemoteId(id: EntityId): { projectId: string; datasetName: string; typeName: string } {
  const [projectId, datasetName, typeName] = id.remoteId;
  if (!projectId || !datasetName || !typeName) {
    throw new SanityError(
      `Invalid Sanity table id: expected [projectId, dataset, type], got [${id.remoteId.join(', ')}]`,
    );
  }
  return { projectId, datasetName, typeName };
}

export class SanityConnector extends Connector {
  readonly service = Service.SANITY;
  static readonly displayName = 'Sanity';
  static readonly metadata = connectorMetadata({
    displayName: 'Sanity',
    table: 'document type',
    tables: 'document types',
    record: 'document',
    records: 'documents',
    base: 'dataset',
    bases: 'datasets',
    logo: 'https://static.scratch.md/connector-icons/sanity.svg',
    visible: true,
    incrementalPull: true,
    defaultAuthMethod: 'user_provided_params',
    credentialFields: {
      user_provided_params: [
        { key: 'apiKey', type: 'password', label: 'API Token', required: true, placeholder: 'sk...' },
        { key: 'sanityProjectId', type: 'string', label: 'Project ID', required: false },
      ],
    },
  });

  private readonly client: SanityApiClient;
  private readonly configuredProjectId?: string;
  private resolvedProjectIdPromise?: Promise<string>;

  constructor(apiToken: string, opts?: { projectId?: string; rateLimiter?: RateLimiter }) {
    super();
    this.client = new SanityApiClient(apiToken, { rateLimiter: opts?.rateLimiter });
    this.configuredProjectId = opts?.projectId?.trim() || undefined;
  }

  /**
   * The project this connection targets. Robot tokens are project-scoped, so the token
   * normally identifies exactly one project; a user-provided project id disambiguates
   * tokens (e.g. personal ones) that can see several.
   */
  private resolveProjectId(): Promise<string> {
    if (!this.resolvedProjectIdPromise) {
      this.resolvedProjectIdPromise = this.lookUpProjectIdFromTokenOrConfig();
    }
    return this.resolvedProjectIdPromise;
  }

  private async lookUpProjectIdFromTokenOrConfig(): Promise<string> {
    if (this.configuredProjectId) return this.configuredProjectId;
    const accessibleProjects = await this.client.listProjects();
    if (accessibleProjects.length === 0) {
      throw new SanityError('This API token has no access to any Sanity project.', 403);
    }
    if (accessibleProjects.length > 1) {
      const projectSummaries = accessibleProjects.map((p) => `${p.displayName} (${p.id})`).join(', ');
      throw new SanityError(
        `This API token can access ${accessibleProjects.length} projects (${projectSummaries}). ` +
          'Set the Project ID connection field to choose one.',
        400,
      );
    }
    return accessibleProjects[0].id;
  }

  /** Validate the token: resolve the project it belongs to and list its datasets. */
  async testConnection(): Promise<void> {
    const projectId = await this.resolveProjectId();
    await this.client.listDatasets(projectId);
  }

  /**
   * Each user-defined `_type` in each dataset is a table. The type list comes from the
   * documents themselves (`array::unique(*[]._type)`) because the Content Lake has no
   * mandatory schema registry — a type with zero documents is invisible until it has one.
   */
  async listTables(): Promise<TablePreview[]> {
    const projectId = await this.resolveProjectId();
    const datasets = await this.client.listDatasets(projectId);

    const tables: TablePreview[] = [];
    for (const dataset of datasets) {
      const allTypeNames = await this.client.query<string[]>(projectId, dataset.name, 'array::unique(*[]._type)');
      const userTypeNames = allTypeNames
        .filter((typeName) => !SANITY_INTERNAL_TYPE_NAME_PREFIXES.some((prefix) => typeName.startsWith(prefix)))
        .sort();
      for (const typeName of userTypeNames) {
        tables.push({
          id: {
            wsId: sanitizeForTableWsId(`${dataset.name}_${typeName}`),
            remoteId: [projectId, dataset.name, typeName],
          },
          displayName: typeName,
          parentPath: dataset.name,
        });
      }
    }
    return tables;
  }

  /** Pure spec → view: curated column order, PT preview flattening, hidden system fields. */
  override buildDefaultView(spec: BaseJsonTableSpec): TableView | undefined {
    return buildSanityDefaultView(spec);
  }

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const { projectId, datasetName, typeName } = parseSanityTableRemoteId(id);
    // Sample the most recently edited documents — they best reflect the current model.
    const sampledDocuments = await this.client.query<SanityDocument[]>(
      projectId,
      datasetName,
      `*[_type == $type] | order(_updatedAt desc) [0...${SANITY_SCHEMA_INFERENCE_SAMPLE_SIZE}]`,
      { type: typeName },
    );
    const deployedTypeEnrichment = await this.fetchDeployedSchemaEnrichmentForType(projectId, datasetName, typeName);

    // FK targets: deployed `to:` declarations win outright (authoritative, no sampling
    // needed); ref-id sampling fills in only the fields the deployed schema didn't cover
    // (legacy fields, or no deployed schema at all).
    const deployedReferenceTargets = deployedTypeEnrichment?.referenceTargetTypeNamesByFieldName;
    const sampledReferenceTargets = await this.resolveReferenceFieldTargetTypes(
      projectId,
      datasetName,
      sampledDocuments,
      new Set(deployedReferenceTargets?.keys() ?? []),
    );
    const referenceFieldTargetTypeNames = new Map([
      ...sampledReferenceTargets,
      ...(deployedReferenceTargets ?? new Map<string, string>()),
    ]);

    return buildSanityJsonTableSpec({
      id,
      typeName,
      datasetName,
      sampledDocuments,
      referenceFieldTargetTypeNames,
      deployedTypeEnrichment,
    });
  }

  /**
   * Fetch + parse the deployed Studio schema (`sanity schema deploy` system documents)
   * for one document type. Best-effort on top of inference: a project with no deployed
   * schema returns undefined, and ANY failure (permissions, malformed payload, transient
   * API error) degrades to inference-only rather than failing the spec build.
   */
  private async fetchDeployedSchemaEnrichmentForType(
    projectId: string,
    datasetName: string,
    typeName: string,
  ): Promise<SanityDeployedTypeEnrichment | undefined> {
    try {
      const deployedSchemaDocuments = await this.client.fetchDeployedWorkspaceSchemaDocuments(projectId, datasetName);
      return parseDeployedSchemaEnrichmentsByTypeName(deployedSchemaDocuments).get(typeName);
    } catch (error) {
      WSLogger.warn({
        source: 'SanityConnector',
        message: `Failed to fetch deployed Studio schema for ${projectId}/${datasetName}; using inference only`,
        error,
      });
      return undefined;
    }
  }

  /**
   * Resolve which `_type` each reference field points at, by looking up the sampled
   * `_ref` ids' documents in one GROQ query. A field maps to a target only when every
   * sampled reference agrees on one type — Sanity allows mixed-target references
   * (`to: [{type:'a'},{type:'b'}]`), and those stay unannotated rather than mis-linked.
   * Fields in `fieldNamesAlreadyResolvedByDeployedSchema` are skipped (their target is
   * already known from the deployed schema declaration — no lookup needed for them).
   */
  private async resolveReferenceFieldTargetTypes(
    projectId: string,
    datasetName: string,
    sampledDocuments: SanityDocument[],
    fieldNamesAlreadyResolvedByDeployedSchema: Set<string> = new Set(),
  ): Promise<Map<string, string>> {
    const referenceFieldShapes = collectReferenceFieldSampleRefIds(sampledDocuments);
    for (const alreadyResolvedFieldName of fieldNamesAlreadyResolvedByDeployedSchema) {
      referenceFieldShapes.delete(alreadyResolvedFieldName);
    }
    const targetTypeNamesByFieldName = new Map<string, string>();
    if (referenceFieldShapes.size === 0) return targetTypeNamesByFieldName;

    const allSampleRefIds = [...new Set([...referenceFieldShapes.values()].flatMap((shape) => shape.sampleRefIds))];
    const referencedDocuments = await this.client.query<{ _id: string; _type: string }[]>(
      projectId,
      datasetName,
      '*[_id in $ids]{_id, _type}',
      { ids: allSampleRefIds },
    );
    const typeNameByReferencedId = new Map(referencedDocuments.map((doc) => [doc._id, doc._type]));

    for (const [fieldName, shape] of referenceFieldShapes.entries()) {
      const resolvedTargetTypeNames = new Set(
        shape.sampleRefIds
          .map((refId) => typeNameByReferencedId.get(refId))
          .filter((typeName): typeName is string => !!typeName),
      );
      if (resolvedTargetTypeNames.size === 1) {
        targetTypeNamesByFieldName.set(fieldName, [...resolvedTargetTypeNames][0]);
      }
    }
    return targetTypeNamesByFieldName;
  }

  /**
   * Every document carries the service-written `_updatedAt`, so incremental pulls are
   * supported unconditionally (fixed system field — no per-folder config to inspect).
   */
  override incrementalPullSupport(): IncrementalPullSupport {
    return IncrementalPullSupport.SUPPORTED;
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: SanityPullProgress }) => Promise<void>,
    progress: SanityPullProgress,
    options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const { projectId, datasetName, typeName } = parseSanityTableRemoteId(tableSpec.id);
    // Cursor pagination on `_id` order: stable across pages and resumable mid-pull.
    let lastPulledDocumentId = progress?.lastPulledDocumentId ?? '';

    // Watermark BEFORE the first API call — anything modified mid-pull is re-pulled
    // next run rather than skipped; idempotent commits absorb the duplicates.
    let newWatermark: Date | undefined;
    let modifiedSinceIso: string | undefined;
    if (options.pullMode === 'incremental' && options.since instanceof Date) {
      newWatermark = new Date();
      modifiedSinceIso = buildSanityIncrementalSinceParam(options.since);
    }

    for (;;) {
      const documentsPage = await this.client.fetchDocumentsPageOrderedById(
        projectId,
        datasetName,
        typeName,
        lastPulledDocumentId,
        SANITY_PULL_PAGE_SIZE,
        modifiedSinceIso,
      );
      if (documentsPage.length === 0) break;
      lastPulledDocumentId = documentsPage[documentsPage.length - 1]._id;
      await callback({
        files: documentsPage as unknown as ConnectorFile[],
        connectorProgress: { lastPulledDocumentId },
      });
      if (documentsPage.length < SANITY_PULL_PAGE_SIZE) break;
    }
    return newWatermark ? { newWatermark } : {};
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const { projectId, datasetName, typeName } = parseSanityTableRemoteId(tableSpec.id);
    for (let chunkStart = 0; chunkStart < ids.length; chunkStart += SANITY_PULL_PAGE_SIZE) {
      const idChunk = ids.slice(chunkStart, chunkStart + SANITY_PULL_PAGE_SIZE);
      // Missing ids simply return no document — the "silently skip 404s" contract.
      const documents = await this.client.query<SanityDocument[]>(
        projectId,
        datasetName,
        '*[_type == $type && _id in $ids]',
        { type: typeName, ids: idChunk },
      );
      if (documents.length > 0) {
        await callback({ files: documents as unknown as ConnectorFile[] });
      }
    }
  }

  getBatchSize(): number {
    return SANITY_MUTATION_BATCH_SIZE;
  }

  /** New documents start with their `_type` set — it's required on create. */
  // eslint-disable-next-line @typescript-eslint/require-await
  override async getNewFile(tableSpec: BaseJsonTableSpec): Promise<ConnectorFile> {
    const { typeName } = parseSanityTableRemoteId(tableSpec.id);
    return { _type: typeName };
  }

  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const { projectId, datasetName, typeName } = parseSanityTableRemoteId(tableSpec.id);
    const createMutations: SanityMutation[] = files.map((file) => ({
      // The file's own fields win; `_type` is only defaulted when the file lacks it.
      create: { _type: typeName, ...file },
    }));
    const response = await this.client.mutate(projectId, datasetName, createMutations, { returnDocuments: true });
    return response.results.map(
      (result, index) => (result.document ?? { ...files[index], _id: result.id }) as ConnectorFile,
    );
  }

  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const { projectId, datasetName } = parseSanityTableRemoteId(tableSpec.id);

    const patchMutations: SanityMutation[] = [];
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const remoteDocumentId = readRecordIdAsString(files[fileIndex], tableSpec.idPath);
      if (!remoteDocumentId) {
        throw new SanityError('Cannot update a Sanity document that has no `_id`.');
      }
      const attributePathToValueMap = flattenChangedFieldsToSanityAttributePaths(
        changedFields[fileIndex] ?? {},
        files[fileIndex],
      );
      if (Object.keys(attributePathToValueMap).length === 0) continue;
      patchMutations.push({ patch: { id: remoteDocumentId, set: attributePathToValueMap } });
    }

    if (patchMutations.length === 0) return files;
    const response = await this.client.mutate(projectId, datasetName, patchMutations, { returnDocuments: true });

    // Pair persisted documents back to the input files by id (skipped files keep their sent payload).
    const persistedDocumentsById = new Map(
      response.results.filter((result) => result.document).map((result) => [result.id, result.document]),
    );
    return files.map((file) => {
      const remoteDocumentId = readRecordIdAsString(file, tableSpec.idPath);
      const persistedDocument = remoteDocumentId ? persistedDocumentsById.get(remoteDocumentId) : undefined;
      return persistedDocument ?? file;
    });
  }

  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const { projectId, datasetName } = parseSanityTableRemoteId(tableSpec.id);
    const deleteMutations: SanityMutation[] = [];
    for (const file of files) {
      const remoteDocumentId = readRecordIdAsString(file, tableSpec.idPath);
      // A file with no remote id was never published — nothing to delete remotely.
      if (!remoteDocumentId) continue;
      deleteMutations.push({ delete: { id: remoteDocumentId } });
    }
    if (deleteMutations.length === 0) return;
    // Deleting an already-deleted id is a no-op in Sanity, so this is naturally idempotent.
    await this.client.mutate(projectId, datasetName, deleteMutations);
  }

  getSuggestedRecordFileNames(records: ConnectorFile[], tableSpec: BaseJsonTableSpec): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, tableSpec.slugPath, tableSpec.titlePath, 'title', 'name');
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    if (error instanceof SanityError) {
      return {
        userFriendlyMessage: error.message,
        description: error.message,
        additionalContext: { status: error.statusCode, responseData: error.responseData },
      };
    }
    if (isAxiosError(error)) {
      const commonDetails = extractCommonDetailsFromAxiosError(this, error);
      if (commonDetails) return commonDetails;
      const sanityErrorDescription = SanityApiClient.extractSanityErrorDescription(error);
      if (sanityErrorDescription) {
        return {
          userFriendlyMessage: `Sanity: ${sanityErrorDescription}`,
          description: error.message,
          additionalContext: { status: error.response?.status },
        };
      }
    }
    return this.fallbackErrorDetails(error);
  }
}

/**
 * Flatten a deep sparse changed-fields object into the flat `{ "a.b.c": value }`
 * attribute-path map Sanity's `patch.set` expects. Recursion stops at arrays and
 * non-plain-object leaves (they're set wholesale — array surgery needs `_key`-based
 * paths, a later refinement).
 *
 * A nested key unsafe to embed in an attribute path (Sanity's JSONMatch paths take
 * identifier segments; the schemaless Content Lake legally holds keys like `zip-code`
 * or `en-US`) stops recursion, so the whole parent object is `set` wholesale. Because
 * `set` REPLACES the value at that path and `changedFields` is a SPARSE diff, the
 * wholesale value must come from `fullRecordContent` (the complete resolved record) —
 * setting the sparse subtree would silently delete its untouched siblings (found by
 * adversarial review, 2026-08-01).
 */
export function flattenChangedFieldsToSanityAttributePaths(
  changedFields: Record<string, unknown>,
  fullRecordContent?: Record<string, unknown>,
): Record<string, unknown> {
  const attributePathToValueMap: Record<string, unknown> = {};
  const isSafeAttributePathSegment = (key: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
  const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

  const flattenInto = (
    sparseChangedNode: Record<string, unknown>,
    fullRecordNode: Record<string, unknown> | undefined,
    pathPrefix: string,
  ) => {
    for (const [key, sparseChangedValue] of Object.entries(sparseChangedNode)) {
      if (pathPrefix === '' && !isSafeAttributePathSegment(key)) {
        throw new SanityError(`Cannot update Sanity field "${key}": its name can't be expressed as a patch path.`);
      }
      const attributePath = pathPrefix === '' ? key : `${pathPrefix}.${key}`;
      const fullRecordValue = fullRecordNode?.[key];
      const isPlainObjectWithSafeKeys =
        isPlainObject(sparseChangedValue) && Object.keys(sparseChangedValue).every(isSafeAttributePathSegment);
      if (isPlainObjectWithSafeKeys && Object.keys(sparseChangedValue).length > 0) {
        flattenInto(sparseChangedValue, isPlainObject(fullRecordValue) ? fullRecordValue : undefined, attributePath);
      } else if (isPlainObject(sparseChangedValue) && isPlainObject(fullRecordValue)) {
        // Wholesale-set an object subtree (unsafe keys or empty diff): use the FULL
        // current subtree so untouched siblings survive the replace.
        attributePathToValueMap[attributePath] = fullRecordValue;
      } else {
        attributePathToValueMap[attributePath] = sparseChangedValue;
      }
    }
  };

  flattenInto(changedFields, fullRecordContent, '');
  return attributePathToValueMap;
}

connectorRegistry.register({
  service: Service.SANITY,
  metadata: SanityConnector.metadata,
  advancedSettings: [],
  // Sanity allows 25 mutation req/s and 500 global req/s; 25/s stays safe for both.
  rateLimiterSpec: { points: 25, duration: 1 },
  supportedAuthMethods: ['user_provided_params'],
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    if (!ctx.connectorAccount) {
      throw new ConnectorInstantiationError('Connector account is required for Sanity', Service.SANITY);
    }
    const apiToken = ctx.decryptedCredentials?.apiKey;
    if (!apiToken) {
      throw new ConnectorInstantiationError('API token is required for Sanity', Service.SANITY);
    }
    const rateLimiter = ctx.createRateLimiter(ctx.connectorAccount.id);
    return new SanityConnector(apiToken, { projectId: ctx.decryptedCredentials?.sanityProjectId, rateLimiter });
  },
});
