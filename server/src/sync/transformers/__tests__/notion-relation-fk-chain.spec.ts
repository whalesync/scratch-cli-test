import { Type } from '@sinclair/typebox';
import { DataFolderId, TransformerConfig, X_SCRATCH_FOREIGN_KEY_OPTIONS } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { computeChangedFields } from 'src/publish-plan/diff-utils';
import { FileIndexService } from 'src/publish-plan/file-index.service';
import { RefCleanerService } from 'src/publish-plan/ref-cleaner.service';
import { RefResolverService } from 'src/publish-plan/ref-resolver.service';
import { Service } from 'src/remote-service/connectors/service-constants';
import { JsonSafeValue, ParsedContent, Schema } from 'src/utils/objects';
import { createNullLookupTools } from '../lookup-tools';
import { applyTransformerPipeline, PipelineBaseContext } from '../transformer-pipeline';
import { FkMappingResult, SyncRecord } from '../transformer.types';

// Register the transformers the production chain uses.
import '../implementations/map-array.transformer';
import '../implementations/source-fk-to-dest-fk.transformer';
import '../implementations/wrap-object.transformer';

/**
 * DEV-10942 wire-through: the EXACT pipeline the sync-draft FK attach pass persists for a
 * Webflow multiref → Notion relation column, run through the real pipeline executor and then
 * the real publish-side machinery:
 *
 *   1. sync:      [source_fk_to_dest_fk, relation pack] → the on-disk Notion envelope,
 *                 carrying a real page id + a pseudo-ref for a co-pending category
 *   2. plan-build: stripPseudoRefs drops the co-pending element (create payload is valid),
 *                 computeChangedFields captures the full envelope for the backfill op
 *   3. backfill:  resolveBatchPseudoRefs resolves the pseudo-ref nested inside the envelope
 *                 once the referenced create has landed in the FileIndex
 *
 * Each stage is unit-tested on its own elsewhere; this pins that they COMPOSE — the seam the
 * original bug lived in (each stage was individually "correct" while the chain as a whole
 * shipped raw id arrays to Notion).
 */
describe('Notion relation FK chain — sync → strip → backfill (composed)', () => {
  const CATEGORIES_FOLDER_ID = 'dfd_categories' as DataFolderId;
  const PUBLISHED_CATEGORY_PAGE_ID = '11111111-2222-3333-4444-555555555555';
  const PENDING_CATEGORY_FILENAME = 'scratch_pending_publish_abc.json';
  const PENDING_CATEGORY_PSEUDO_REF = `@/Notion/categories/${PENDING_CATEGORY_FILENAME}`;
  const PENDING_CATEGORY_PAGE_ID_AFTER_CREATE = '99999999-8888-7777-6666-555555555555';

  // The chain exactly as attachForeignKeyResolutionTransformers persists it for a raw-id-array
  // source (Webflow multiref needs no extraction step) into a Notion relation destination.
  const persistedTransformerChain: TransformerConfig[] = [
    {
      type: 'source_fk_to_dest_fk',
      options: { referencedDataFolderId: CATEGORIES_FOLDER_ID, outputType: 'array' },
    },
    {
      type: 'map_array',
      options: {
        elementTransformer: { type: 'wrap_object', options: { template: { id: '$value' } } },
        resultTemplate: { type: 'relation', relation: '$value' },
      },
    },
  ];

  const fkMappingBySourceId: Record<string, FkMappingResult> = {
    'webflow-cat-published': {
      destinationRemoteId: PUBLISHED_CATEGORY_PAGE_ID,
      destinationFilePath: 'categories/one.json',
      destinationConnectionFolder: 'Notion',
    },
    'webflow-cat-pending': {
      // A co-pending destination record: its remote id is still the pending-publish
      // sentinel, so the transformer must emit the workspace-absolute pseudo-ref.
      destinationRemoteId: 'scratch_pending_publish_abc',
      destinationFilePath: `categories/${PENDING_CATEGORY_FILENAME}`,
      destinationConnectionFolder: 'Notion',
    },
  };

  function notionRecordSchema(): Schema {
    const fkOptions = { linkedTableId: 'categories-db' };
    return Type.Object({
      id: Type.String(),
      properties: Type.Object({
        Category: Type.Object(
          {
            type: Type.String(),
            relation: Type.Array(Type.Object({ id: Type.String({ [X_SCRATCH_FOREIGN_KEY_OPTIONS]: fkOptions }) })),
            has_more: Type.Boolean(),
          },
          { [X_SCRATCH_FOREIGN_KEY_OPTIONS]: fkOptions },
        ),
      }),
    }) as unknown as Schema;
  }

  async function runSyncChain(sourceValue: unknown): Promise<JsonSafeValue> {
    const sourceRecord: SyncRecord = {
      id: 'wf_prod_1',
      filePath: '/products/p.json',
      fields: { 'fieldData.category': sourceValue },
    };
    const baseCtx: PipelineBaseContext = {
      sourceRecord,
      sourceFieldPath: 'fieldData.category',
      sourceTableSpec: null,
      sourceService: Service.WEBFLOW,
      destinationFieldPath: 'properties.Category',
      destinationTableSpec: null,
      destinationService: Service.NOTION,
      lookupTools: {
        ...createNullLookupTools(),
        getDestinationMappingForSourceFk: (sourceFkValue: string) =>
          Promise.resolve(fkMappingBySourceId[sourceFkValue] ?? null),
      },
      phase: 'FOREIGN_KEY_MAPPING',
    };
    const result = await applyTransformerPipeline(persistedTransformerChain, sourceValue, baseCtx);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    // The pipeline's value is `unknown`; every chain output here is a JSON-safe envelope.
    return result.value as JsonSafeValue;
  }

  it('sync emits the Notion envelope with a resolved id and a pseudo-ref for the co-pending link', async () => {
    const envelope = await runSyncChain(['webflow-cat-published', 'webflow-cat-pending']);
    expect(envelope).toEqual({
      type: 'relation',
      relation: [{ id: PUBLISHED_CATEGORY_PAGE_ID }, { id: PENDING_CATEGORY_PSEUDO_REF }],
    });
  });

  it('sync emits the cleared envelope (relation: []) for an empty source link', async () => {
    expect(await runSyncChain(null)).toEqual({ type: 'relation', relation: [] });
  });

  it('sync wraps a SCALAR source (Webflow single-Reference id) into a one-element relation', async () => {
    // The exact DEV-10942 regression report: `fieldData.default-sku` / `fieldData.product` /
    // `fieldData.countryfk` are single-Reference fields — one id string, not an array. The
    // FK transformer must honor outputType: 'array' (the destination-shape contract) so the
    // pack never sees a bare scalar ("map_array expects an array as input").
    const envelope = await runSyncChain('webflow-cat-published');
    expect(envelope).toEqual({
      type: 'relation',
      relation: [{ id: PUBLISHED_CATEGORY_PAGE_ID }],
    });
  });

  it('plan-build strips the co-pending element from the create payload and defers it to backfill', async () => {
    const envelope = await runSyncChain(['webflow-cat-published', 'webflow-cat-pending']);
    const pendingProductFileContent: ParsedContent = {
      id: 'scratch_pending_publish_prod',
      properties: { Category: envelope },
    };
    const refCleaner = new RefCleanerService();
    const schema = notionRecordSchema();

    // Pass 2 of plan-build: the create payload keeps only the resolvable link.
    const strippedForCreate = refCleaner.stripPseudoRefs(pendingProductFileContent, schema) as Record<string, unknown>;
    expect(strippedForCreate).toEqual({
      id: 'scratch_pending_publish_prod',
      properties: {
        Category: { type: 'relation', relation: [{ id: PUBLISHED_CATEGORY_PAGE_ID }] },
      },
    });

    // The stripped ref lands in the backfill op's sparse changedFields, still as a pseudo-ref.
    const backfillChangedFields = computeChangedFields(
      strippedForCreate,
      pendingProductFileContent as Record<string, unknown>,
    );
    expect(backfillChangedFields).toEqual({
      properties: {
        Category: {
          relation: [{ id: PUBLISHED_CATEGORY_PAGE_ID }, { id: PENDING_CATEGORY_PSEUDO_REF }],
        },
      },
    });
  });

  it('backfill resolves the pseudo-ref nested inside the envelope once the create has landed', async () => {
    const envelope = await runSyncChain(['webflow-cat-published', 'webflow-cat-pending']);
    const backfillContent: ParsedContent = {
      id: 'scratch_pending_publish_prod',
      properties: { Category: envelope },
    };

    // The referenced category's create has landed: the FileIndex now maps its pending file
    // to the real Notion page id (the resolver keys lookups `folderPath:filename`).
    const fileIndexService = {
      getRecordIds: jest
        .fn()
        .mockResolvedValue(
          new Map([[`categories:${PENDING_CATEGORY_FILENAME}`, PENDING_CATEGORY_PAGE_ID_AFTER_CREATE]]),
        ),
    } as unknown as FileIndexService;
    const db = {
      client: {
        connectorAccount: {
          findMany: jest.fn().mockResolvedValue([{ id: 'coa_notion', service: 'NOTION', displayName: 'Notion' }]),
        },
        asset: { findMany: jest.fn().mockResolvedValue([]) },
      },
    } as unknown as DbService;

    const refResolver = new RefResolverService(fileIndexService, db);
    const [resolved] = await refResolver.resolveBatchPseudoRefs('wkb_1', [backfillContent], undefined, 'coa_notion');

    expect(resolved).toEqual({
      id: 'scratch_pending_publish_prod',
      properties: {
        Category: {
          type: 'relation',
          relation: [{ id: PUBLISHED_CATEGORY_PAGE_ID }, { id: PENDING_CATEGORY_PAGE_ID_AFTER_CREATE }],
        },
      },
    });
  });
});
