import { connectorMetadata } from '@spinner/shared-types';
import { JsonSafeObject } from 'src/utils/objects';
import { Connector, suggestFileNamesFromFieldPaths } from '../../connector';
import { connectorRegistry } from '../../connector-registry';
import { ConnectorInstantiationError } from '../../error';
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
import { FramerApiClient, FramerWriteItem } from './framer-api-client';
import { buildFramerJsonTableSpec } from './framer-json-schema';
import {
  FramerCredentials,
  FramerFieldDataEntry,
  FramerFieldType,
  FramerItemFile,
  FramerWriteTranslationMaps,
  framerWriteNeedsIdTranslation,
  isFramerAssetFieldType,
} from './framer-types';

/**
 * ============================================================================
 * Framer connector — design notes & KNOWN QUIRKS (read before reviewing)
 * ============================================================================
 * The items below are deliberate, live-verified decisions and Framer/platform
 * behaviors — NOT bugs. Validated end-to-end via the scratchmd CLI round-trip and
 * an adversarial review. If a review flags one of these, it's working as intended;
 * the rationale is here so the next reviewer (human or AI) can skip re-litigating.
 *
 * TRANSPORT (see framer-api-client.ts)
 *  Q1. No REST API. The Server API is a stateful WebSocket reached only via the
 *      ESM `framer-api` SDK. The server runs as CommonJS and the SDK's module graph
 *      uses top-level await, so a static import crashes boot (ERR_REQUIRE_ASYNC_MODULE).
 *      It's loaded via a `Function('return import(...)')` dynamic import; every SDK
 *      reference is type-only. This is also why the live integration spec can't run
 *      in the CJS jest harness (--experimental-vm-modules then breaks nanoid).
 *  Q2. One short-lived WebSocket PER operation (connect → do → disconnect), ~1-2s
 *      cold start. A create/update opens up to three (translation maps, upsert,
 *      read-back). Accepted trade-off; consolidating to one is a tracked follow-up.
 *  Q3. getItems() returns the WHOLE collection (no pagination cursor in the SDK),
 *      so pullRecordFiles emits a single batch.
 *
 * STORAGE SHAPE (verbatim — fidelity principle)
 *  Q4. Records are stored exactly as the SDK returns them:
 *      { id, nodeId, slug, slugByLocale, draft, fieldData: { <fieldId>: { type, value, valueByLocale } } }.
 *      fieldData is keyed by stable field id; the editable leaf is fieldData.<id>.value.
 *      id/nodeId/slugByLocale and each entry's type/valueByLocale are read-only.
 *
 * READ ≠ WRITE — translated on write (getWriteTranslationMaps / translateValueToId)
 *  Q5. enum reads as the case NAME ("Live") but writes the case ID. Translated.
 *  Q6. collectionReference reads as the target's SLUG but writes the target item ID;
 *      multiCollectionReference is the array form. Translated (slug/name → id).
 *      Maps key by both read-value AND id, with name/slug winning deterministically,
 *      so a value that's already an id passes through (e.g. an FK picker writing ids).
 *  Q7. image/file read as an asset object { url, ... } but write a bare URL string
 *      (.url extracted). Framer re-hosts an external URL under framerusercontent.com,
 *      so the read-back URL legitimately differs from the one sent.
 *
 * SERVICE-SIDE NORMALIZATION (a transient phantom diff, reconciled on read-back)
 *  Q8. date is stored as ISO — a date-only "2026-12-25" → "2026-12-25T00:00:00.000Z"
 *      (midnight), but a supplied time IS preserved (no day-snapping); color
 *      "#FF0000" → "rgb(255, 0, 0)"; formattedText gains dir="auto" on block tags.
 *      The write lands; updateRecords returns the normalized read-back so `main` is
 *      canonical and the working-copy diff clears on the next pull. A slug edit
 *      normalizes the same way a create does (Q15).
 *
 * WRITE SEMANTICS
 *  Q9.  addItems is an UPSERT (id present = update) and ATOMIC PER ITEM: one invalid
 *       field rejects the whole item, yet the publish job may still report "Published"
 *       (platform behavior). Always verify a write in the service, not the CLI line.
 *  Q10. Partial fieldData on update MERGES — unsent fields are preserved, not wiped.
 *  Q11. Clearing a field to "" clears it; clearing to null is dropped by the CLI's
 *       merge-patch (computeChangedFields ignores deleted keys). Send "" to clear.
 *  Q12. A create read-back miss THROWS rather than returning an id-less record, so a
 *       created record never lands without its remote id.
 *
 * FOREIGN KEYS
 *  Q13. FK annotation sits on the value leaf; generic FK discovery follows the nested
 *       fieldData.<id>.value path. The CLI move-parent→parent (write) test passes for
 *       single + multi reference. Caveat: references store slugs while the target's
 *       remote id is the item id, so cross-record FK *resolution* (picker/sync) is a
 *       known follow-up (see STATE.md → Foreign keys).
 *
 * IDENTITY / LIFECYCLE
 *  Q14. Collection id = the Scratch table wsId & remoteId. Item slug = filename
 *       (unique per collection); the item id lives inside the file and arrives after
 *       create. Collections can be created via the SDK but NOT deleted (no API), so
 *       test fixtures are durable and round-trip items, not tables.
 *  Q15. Framer NORMALIZES the slug on create ("Hello World!" -> "hello-world":
 *       lowercase, ASCII spaces/punctuation -> dashes; unicode/emoji preserved;
 *       a duplicate slug throws "Duplicate slug"). So createRecords does NOT read
 *       back by the sent slug — it id-diffs (snapshot ids, create, new ids in input
 *       order) so the server id is captured even when the slug was rewritten.
 * ============================================================================
 *
 * Connector for Framer's CMS over the Server API (beta). One connection = one
 * Framer project (the API key scopes to the site it was generated in); each CMS
 * collection is a table and each CMS item is a record stored verbatim.
 */
export class FramerConnector extends Connector {
  readonly service = Service.FRAMER;
  static readonly displayName = 'Framer';
  static readonly metadata = connectorMetadata({
    displayName: 'Framer',
    table: 'collection',
    tables: 'collections',
    record: 'item',
    records: 'items',
    base: null,
    bases: null,
    logo: 'https://static.scratch.md/connector-icons/framer.svg',
    // Visible in the product. Validated end-to-end via the scratchmd CLI (full CRUD
    // incl. image write, FK re-parent) and an adversarial codex review; logo serves
    // 200. Maintainer sign-off granted 2026-06-25 (DEV-10491).
    visible: true,
    incrementalPull: false,
    incrementalPullInstructions: null,
    supportsSchemaCreation: false,
    supportedAuthMethods: ['user_provided_params'],
    defaultAuthMethod: 'user_provided_params',
    userProvidedParamsLabel: 'API Key',
    credentialFields: {
      user_provided_params: [
        {
          key: 'projectUrl',
          type: 'string',
          label: 'Project URL',
          placeholder: 'https://framer.com/projects/Your-Site--abc123',
          required: true,
        },
        { key: 'apiKey', type: 'password', label: 'API Key', placeholder: 'fr_...', required: true },
      ],
    },
  });

  private readonly client: FramerApiClient;

  constructor(credentials: FramerCredentials) {
    super();
    this.client = new FramerApiClient(credentials);
  }

  async testConnection(): Promise<void> {
    // Throws on bad credentials / unreachable project.
    await this.client.getProjectInfo();
  }

  async listTables(): Promise<TablePreview[]> {
    const collections = await this.client.listCollections();
    return collections.map((collection) => ({
      // The collection id is stable, unique, and postgres-safe — use it as the wsId.
      id: { wsId: collection.id, remoteId: [collection.id] },
      displayName: collection.name,
    }));
  }

  async fetchJsonTableSpec(id: EntityId): Promise<BaseJsonTableSpec> {
    const collectionId = id.remoteId[0];
    const collection = await this.client.getCollectionMeta(collectionId);
    if (!collection) {
      throw new Error(`Framer collection ${collectionId} not found`);
    }
    return buildFramerJsonTableSpec(id, collection);
  }

  async pullRecordFiles(
    tableSpec: BaseJsonTableSpec,
    callback: (params: { files: ConnectorFile[]; connectorProgress?: JsonSafeObject }) => Promise<void>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _progress: JsonSafeObject,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: PullRecordFilesOptions,
  ): Promise<PullRecordFilesResult> {
    const collectionId = tableSpec.id.remoteId[0];
    // The SDK returns every item in one call (no pagination cursor), so a single
    // batch covers the collection.
    const items = await this.client.getItems(collectionId);
    if (items.length > 0) {
      await callback({ files: items as unknown as ConnectorFile[] });
    }
    return {};
  }

  async pullRecordFilesByIds(
    tableSpec: BaseJsonTableSpec,
    ids: string[],
    callback: (params: { files: ConnectorFile[] }) => Promise<void>,
  ): Promise<void> {
    const collectionId = tableSpec.id.remoteId[0];
    const items = await this.client.getItemsByIds(collectionId, ids);
    if (items.length > 0) {
      await callback({ files: items as unknown as ConnectorFile[] });
    }
  }

  getBatchSize(): number {
    return 50;
  }

  async createRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<ConnectorFile[]> {
    const collectionId = tableSpec.id.remoteId[0];

    const writeItems: FramerWriteItem[] = files.map((file) => {
      const item = file as unknown as FramerItemFile;
      const writeItem: FramerWriteItem = { slug: item.slug, fieldData: toWriteFieldData(item.fieldData) };
      if (typeof item.draft === 'boolean') writeItem.draft = item.draft;
      return writeItem;
    });

    await this.translateEnumAndReferenceValuesToIds(collectionId, writeItems);

    // addItems returns no ids, and Framer NORMALIZES the slug on create (e.g.
    // "Hello World!" -> "hello-world"), so the sent slug is NOT a reliable read-back
    // key. Instead, snapshot the existing item ids, create, then the items whose id
    // is new are the created ones — in INPUT order (getItems appends new items in
    // creation order; verified). This captures the server id even when the slug was
    // rewritten, and never matches against a normalized-away slug.
    const existingIds = new Set((await this.client.getItems(collectionId)).map((existing) => existing.id));
    await this.client.upsertItems(collectionId, writeItems);
    const createdInInputOrder = (await this.client.getItems(collectionId)).filter((item) => !existingIds.has(item.id));

    if (createdInInputOrder.length < files.length) {
      // Fewer new items than inputs means at least one create did not land. Fail loudly
      // so no record is returned without its remote id (an id-less record would re-create
      // as a duplicate on the next pull).
      throw new Error(
        `Framer create returned ${createdInInputOrder.length} new item(s) for ${files.length} input record(s); aborting to avoid an id-less record.`,
      );
    }

    return files.map((_file, index) => createdInInputOrder[index] as unknown as ConnectorFile);
  }

  async updateRecords(
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: Record<string, unknown>[],
  ): Promise<ConnectorFile[]> {
    const collectionId = tableSpec.id.remoteId[0];

    const writeItems: FramerWriteItem[] = files.map((file, index) => {
      const item = file as unknown as FramerItemFile;
      const changed = changedFields[index] ?? {};
      const writeItem: FramerWriteItem = { id: item.id };

      if (typeof changed.slug === 'string') writeItem.slug = changed.slug;
      if (typeof changed.draft === 'boolean') writeItem.draft = changed.draft;

      const changedFieldData = changed.fieldData;
      if (changedFieldData && typeof changedFieldData === 'object') {
        writeItem.fieldData = {};
        for (const [fieldId, changedEntryRaw] of Object.entries(changedFieldData as Record<string, unknown>)) {
          const changedEntry =
            changedEntryRaw && typeof changedEntryRaw === 'object'
              ? (changedEntryRaw as { type?: unknown; value?: unknown })
              : undefined;
          const fullEntry = item.fieldData?.[fieldId];
          const type = typeof changedEntry?.type === 'string' ? changedEntry.type : fullEntry?.type;
          if (typeof type !== 'string') continue;
          const rawValue = changedEntry && 'value' in changedEntry ? changedEntry.value : fullEntry?.value;
          writeItem.fieldData[fieldId] = { type, value: toWriteValue(type, rawValue) };
        }
      }

      return writeItem;
    });

    await this.translateEnumAndReferenceValuesToIds(collectionId, writeItems);
    await this.client.upsertItems(collectionId, writeItems);

    const ids = writeItems.map((writeItem) => writeItem.id).filter((id): id is string => !!id);
    const updated = await this.client.getItemsByIds(collectionId, ids);
    const updatedById = new Map(updated.map((updatedItem) => [updatedItem.id, updatedItem]));

    return files.map((file) => {
      const item = file as unknown as FramerItemFile;
      return (updatedById.get(item.id) ?? item) as unknown as ConnectorFile;
    });
  }

  async deleteRecords(tableSpec: BaseJsonTableSpec, files: ConnectorFile[]): Promise<void> {
    const collectionId = tableSpec.id.remoteId[0];
    const ids = files.map((file) => (file as unknown as FramerItemFile).id).filter((id): id is string => !!id);
    await this.client.removeItems(collectionId, ids);
  }

  getSuggestedRecordFileNames(
    records: ConnectorFile[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _tableSpec: BaseJsonTableSpec,
  ): (string | undefined)[] {
    return suggestFileNamesFromFieldPaths(records, 'slug');
  }

  extractConnectorErrorDetails(error: unknown): ConnectorErrorDetails {
    return this.fallbackErrorDetails(error);
  }

  /**
   * Translate enum/reference values in-place from their stored read-shape (case
   * name / target slug) to the ids Framer's `addItems` requires (case id / item
   * id). Skips the extra round-trip entirely when no written field needs it.
   */
  private async translateEnumAndReferenceValuesToIds(
    collectionId: string,
    writeItems: FramerWriteItem[],
  ): Promise<void> {
    const needsTranslation = writeItems.some(
      (writeItem) =>
        writeItem.fieldData &&
        Object.values(writeItem.fieldData).some((entry) => framerWriteNeedsIdTranslation(entry.type)),
    );
    if (!needsTranslation) return;

    const maps = await this.client.getWriteTranslationMaps(collectionId);
    for (const writeItem of writeItems) {
      if (!writeItem.fieldData) continue;
      for (const [fieldId, entry] of Object.entries(writeItem.fieldData)) {
        entry.value = translateValueToId(entry.type, fieldId, entry.value, maps);
      }
    }
  }
}

/**
 * Map a single enum/reference value (case name / target slug, or an id already)
 * to the id Framer's write API needs. Unmapped values pass through unchanged so a
 * value the maps don't know about still reaches the service (and surfaces its own
 * error) rather than being silently dropped.
 */
export function translateValueToId(
  type: string,
  fieldId: string,
  value: unknown,
  maps: FramerWriteTranslationMaps,
): unknown {
  if (type === FramerFieldType.Enum) {
    return typeof value === 'string' ? (maps.enumCaseIdByValue[fieldId]?.[value] ?? value) : value;
  }
  if (type === FramerFieldType.CollectionReference) {
    return typeof value === 'string' ? (maps.refItemIdByValue[fieldId]?.[value] ?? value) : value;
  }
  if (type === FramerFieldType.MultiCollectionReference) {
    if (!Array.isArray(value)) return value;
    const refMap = maps.refItemIdByValue[fieldId] ?? {};
    return (value as unknown[]).map((entry) => (typeof entry === 'string' ? (refMap[entry] ?? entry) : entry));
  }
  return value;
}

/**
 * Translate a verbatim field value into the shape `addItems` accepts. Asset
 * (image/file) values read back as an object but write as a bare URL string, so
 * pull the `url` out; every other type writes its value as-is.
 */
export function toWriteValue(type: string, value: unknown): unknown {
  if (isFramerAssetFieldType(type) && value && typeof value === 'object' && !Array.isArray(value)) {
    const url = (value as { url?: unknown }).url;
    return typeof url === 'string' ? url : null;
  }
  return value ?? null;
}

/** Build the write `fieldData` from a verbatim record's `fieldData` (drops `valueByLocale`). */
export function toWriteFieldData(
  fieldData: Record<string, FramerFieldDataEntry> | undefined,
): Record<string, { type: string; value: unknown }> {
  const out: Record<string, { type: string; value: unknown }> = {};
  if (!fieldData) return out;
  for (const [fieldId, entry] of Object.entries(fieldData)) {
    if (!entry || typeof entry !== 'object' || typeof entry.type !== 'string') continue;
    out[fieldId] = { type: entry.type, value: toWriteValue(entry.type, entry.value) };
  }
  return out;
}

connectorRegistry.register({
  service: Service.FRAMER,
  metadata: FramerConnector.metadata,
  advancedSettings: [],
  supportedAuthMethods: ['user_provided_params'],
  // eslint-disable-next-line @typescript-eslint/require-await
  async createConnector(ctx) {
    const projectUrl = ctx.decryptedCredentials?.projectUrl;
    const apiKey = ctx.decryptedCredentials?.apiKey;
    if (!projectUrl || !apiKey) {
      throw new ConnectorInstantiationError('Project URL and API key are required for Framer', Service.FRAMER);
    }
    return new FramerConnector({ projectUrl, apiKey });
  },
});
