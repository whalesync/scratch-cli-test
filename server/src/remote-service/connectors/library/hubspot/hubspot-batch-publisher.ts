import { WSLogger } from 'src/logger';
import { PartialBatchCreateError } from '../../error';
import { BaseJsonTableSpec, ConnectorFile } from '../../types';
import { HubspotApiClient, HubspotAssociationsApiVersion, HubspotError } from './hubspot-api-client';
import {
  associationDiffIsEmpty,
  chunkArchivePairsByUniqueFromId,
  chunkArray,
  diffAssociationsById,
  failedPairsFromBatchAssociationResponse,
  groupAssociationWritesAcrossRecords,
  HUBSPOT_BATCH_ARCHIVE_MAX_UNIQUE_FROM_IDS,
  HUBSPOT_BATCH_ASSOCIATE_MAX_INPUTS,
  HUBSPOT_BATCH_PUBLISH_SIZE,
  HubspotAssociationDiffForRecord,
  HubspotAssociationWriteError,
  HubspotBatchCreateUnmappableError,
  HubspotFailedAssociationPair,
  mapBatchCreateResponseToInputs,
  mapBatchUpdateResponseToInputs,
} from './hubspot-batch-publish';
import { HubspotAssociation, HubspotAssociationResult, HubspotRecord } from './hubspot-types';

const LOG_SOURCE = 'HubspotBatchPublisher';

/** The HubSpot object type whose records are published/locked quotes — never cross-record batched. */
const QUOTES_OBJECT_TYPE = 'quotes';

/** Attempts to archive a record created by an unbindable batch before giving it up as orphaned. */
const ROLLBACK_ARCHIVE_ATTEMPTS = 3;
const ROLLBACK_ARCHIVE_RETRY_DELAY_MS = 500;

/**
 * What the batched publish flow needs from the connector: the HTTP client and
 * the connector's own property/association helpers, so both flows compute the
 * writable payload and the association diff the same way.
 */
export interface HubspotBatchPublisherHost {
  readonly client: HubspotApiClient;
  getPropertyNames(objectType: string): Promise<string[]>;
  getAssociationTypes(objectType: string): string[];
  extractWritableProperties(file: ConnectorFile, tableSpec: BaseJsonTableSpec): Record<string, unknown>;
  computeWritablePropertiesToPublish(
    file: ConnectorFile,
    tableSpec: BaseJsonTableSpec,
    changedFieldsForFile: Record<string, unknown> | undefined,
  ): Record<string, unknown>;
  getAssociationsApiVersion(): Promise<HubspotAssociationsApiVersion>;
}

/**
 * The **batched** HubSpot publish flow (DEV-10200, behind `HUBSPOT_BATCH_PUBLISH`).
 *
 * `HubspotConnector` instantiates this only when the flag is on and branches to
 * it at exactly three points — `createRecords`, `updateRecords` (non-quotes) and
 * `syncAssociations` — so the legacy one-record-per-call flow in the connector
 * stays untouched and readable on its own. Everything below is the new flow.
 *
 * Per batch of up to {@link HUBSPOT_BATCH_PUBLISH_SIZE} files of one object type:
 *
 *  1. **Records** — one `batch/create` / `batch/update` call. Every input carries
 *     `objectWriteTraceId` (chunk-local index) so HubSpot answers 207 for a
 *     partial failure, names the rejected inputs, and echoes the trace id on
 *     every created record.
 *  2. **Links** — every file's id-only association diff is merged by
 *     (association type, add | remove) and flushed as one 2026-03
 *     `batch/associate/default` + one `batch/archive` call per type. A rejected
 *     link is **surfaced** (never swallowed) as a {@link HubspotAssociationWriteError}
 *     naming each failed pair.
 *  3. **Refetch** — one `GET …/{id}?associations=` per record, as the legacy flow
 *     does (`batch/read` never returns associations).
 *
 * **Partial-failure contract for creates.** The publish runner retries a thrown
 * batch one record at a time, which would re-create the records HubSpot already
 * created. So once any record exists this never throws a plain error: it throws
 * {@link PartialBatchCreateError}, handing the runner every created record (to
 * persist like a clean batch) plus the reason per failed input. A failed input
 * always has nothing remote: a record that was created but whose link write or
 * refetch failed is archived first ({@link archiveRecordAfterFailedPublish}), so
 * the retry can create it again cleanly. Updates keep throw-or-succeed:
 * re-applying a PATCH or a link write is idempotent.
 *
 * **Binding created records to files.** HubSpot returns `batch/create` results
 * in arbitrary order; each result echoes its input's `objectWriteTraceId`, which
 * binds it to its file (`bindCreatedRecordsByEchoedTraceId`). A response whose
 * results carry no usable trace id is bound by the property values HubSpot
 * echoes back (`matchCreatedRecordsToInputs`); an unbindable batch is archived
 * and retried one record per call.
 *
 * **Quotes** never cross-record batch (their recall window is per record): they
 * publish one call at a time, but through {@link createRecordsOneAtATime} so a
 * failure on quote N still registers quotes 1..N-1.
 */
export class HubspotBatchPublisher {
  /** Logged once per instance when batching is on but the 2026-03 API isn't. */
  private warnedAboutUnbatchedAssociationWrites = false;

  constructor(private readonly host: HubspotBatchPublisherHost) {}

  private get client(): HubspotApiClient {
    return this.host.client;
  }

  // ---------------------------------------------------------------- creates

  /** Entry point from `HubspotConnector.createRecords` when the flag is on. */
  async createRecords(
    objectType: string,
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
  ): Promise<ConnectorFile[]> {
    if (objectType === QUOTES_OBJECT_TYPE) {
      return this.createRecordsOneAtATime(objectType, tableSpec, files);
    }
    return this.createRecordsInBatches(objectType, tableSpec, files);
  }

  /**
   * One `batch/create` per chunk, then the chunk's links, then a per-record
   * refetch. See the class doc for the partial-failure and binding contracts.
   */
  private async createRecordsInBatches(
    objectType: string,
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
  ): Promise<ConnectorFile[]> {
    const propertyNames = await this.host.getPropertyNames(objectType);
    const associationTypes = this.host.getAssociationTypes(objectType);

    const results = new Array<ConnectorFile>(files.length);
    const createdRecordsByInputIndex = new Map<number, ConnectorFile>();
    const failureMessagesByInputIndex = new Map<number, string>();
    let firstFailureCause: unknown;

    const chunks = chunkArray(files, HUBSPOT_BATCH_PUBLISH_SIZE);
    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
      const chunkFiles = chunks[chunkIndex];
      const chunkStartIndex = chunkIndex * HUBSPOT_BATCH_PUBLISH_SIZE;
      // Trace ids are chunk-local: the response mapper resolves them against
      // this call's inputs, and the chunk offset is added back below.
      const inputs = chunkFiles.map((file, indexInChunk) => ({
        objectWriteTraceId: String(indexInChunk),
        properties: this.host.extractWritableProperties(file, tableSpec),
      }));

      // 1. Create the chunk's records.
      let chunkOutcome;
      try {
        const response = await this.client.batchCreateRecords(objectType, inputs);
        chunkOutcome = mapBatchCreateResponseToInputs(response, inputs);
      } catch (error) {
        firstFailureCause ??= error;
        if (error instanceof HubspotBatchCreateUnmappableError) {
          // The records exist but can't be bound to files. Roll them back so the
          // chunk is "nothing created" again; the per-record retry then creates
          // one record per call, which is trivially mappable. Leaving them
          // would orphan them AND let the retry create duplicates. (An archive
          // that itself fails is logged with the orphaned ids; the retry may
          // then duplicate it — accepted as a double fault.)
          await this.rollBackUnmappableCreatedRecords(objectType, error);
        }
        // Read the message after the rollback: a failed rollback appends the orphaned ids.
        const message = error instanceof Error ? error.message : String(error);
        // Whole-call rejection (or a rolled-back chunk): HubSpot holds nothing
        // from this chunk. (A transport failure AFTER HubSpot committed — the
        // connection drops before the response — is indistinguishable from a
        // rejection here and would let the retry duplicate; accepted as a
        // double fault, like a failed archive.) If no earlier chunk created
        // anything either, the
        // ordinary per-record retry is safe — let the raw error drive it.
        // Otherwise fold this chunk (and the rest: the failure is almost
        // certainly systemic) into the partial report so the earlier chunks'
        // ids still get registered.
        if (createdRecordsByInputIndex.size === 0) {
          throw error;
        }
        for (let index = chunkStartIndex; index < files.length; index++) {
          failureMessagesByInputIndex.set(index, message);
        }
        break;
      }
      for (const [indexInChunk, message] of chunkOutcome.failureMessagesByInputIndex) {
        failureMessagesByInputIndex.set(chunkStartIndex + indexInChunk, message);
      }
      const createdIndexesInChunk = [...chunkOutcome.recordsByInputIndex.keys()].map((i) => chunkStartIndex + i);
      for (const [indexInChunk, record] of chunkOutcome.recordsByInputIndex) {
        createdRecordsByInputIndex.set(chunkStartIndex + indexInChunk, record as unknown as ConnectorFile);
      }

      // 2. Their association links, one batch call per association type. A
      //    rejected link fails exactly the records it belongs to (by `from` id);
      //    anything else that goes wrong fails every record in the chunk — they
      //    all exist now, so the runner registers them and the retry re-syncs.
      const createdIdByInputIndex = new Map(
        createdIndexesInChunk.map((index) => [index, (createdRecordsByInputIndex.get(index) as { id: string }).id]),
      );
      const recordDiffs = createdIndexesInChunk.flatMap((index) => {
        const fileAssociations = (files[index] as unknown as HubspotRecord).associations;
        if (!fileAssociations) return [];
        const diff = diffAssociationsById({}, fileAssociations);
        return associationDiffIsEmpty(diff) ? [] : [{ recordId: createdIdByInputIndex.get(index) as string, diff }];
      });
      //    A record whose links were rejected is archived and reported as
      //    failed, so the runner's per-record retry can create it cleanly.
      if (recordDiffs.length > 0) {
        try {
          await this.writeAssociationDiffs(objectType, recordDiffs);
        } catch (error) {
          firstFailureCause ??= error;
          const failedFromIds = new Set(
            error instanceof HubspotAssociationWriteError ? error.failedPairs.map((pair) => pair.fromId) : [],
          );
          const message = error instanceof Error ? error.message : String(error);
          for (const index of createdIndexesInChunk) {
            const recordId = createdIdByInputIndex.get(index) as string;
            if (failedFromIds.size === 0 || failedFromIds.has(recordId)) {
              await this.archiveRecordAfterFailedPublish(objectType, recordId, message);
              createdRecordsByInputIndex.delete(index);
              failureMessagesByInputIndex.set(index, message);
            }
          }
        }
      }

      // 3. Refetch each created record with its associations. A record whose
      //    refetch fails is archived and reported as failed, like a rejected link.
      for (const index of createdIndexesInChunk) {
        if (failureMessagesByInputIndex.has(index)) continue;
        const recordId = createdIdByInputIndex.get(index) as string;
        try {
          const complete = await this.client.getRecord(objectType, recordId, propertyNames, associationTypes);
          if (!complete) {
            // 404 on refetch: the record vanished between create and refetch.
            // Never persist an id that no longer exists — report it failed.
            throw new HubspotError(`${objectType}/${recordId} disappeared before it could be refetched`, 404);
          }
          const completeFile = complete as unknown as ConnectorFile;
          createdRecordsByInputIndex.set(index, completeFile);
          results[index] = completeFile;
        } catch (error) {
          firstFailureCause ??= error;
          const message = error instanceof Error ? error.message : String(error);
          await this.archiveRecordAfterFailedPublish(objectType, recordId, message);
          createdRecordsByInputIndex.delete(index);
          failureMessagesByInputIndex.set(index, message);
        }
      }
    }

    if (failureMessagesByInputIndex.size > 0) {
      if (createdRecordsByInputIndex.size === 0) {
        // Nothing exists remotely, so the ordinary per-record retry is safe;
        // surface HubSpot's reasons as a plain error.
        const described = [...failureMessagesByInputIndex.entries()]
          .map(([index, message]) => `record #${index + 1}: ${message}`)
          .join('; ');
        throw new HubspotError(
          `HubSpot rejected ${failureMessagesByInputIndex.size} of ${files.length} record create(s): ${described}`,
          207,
          'BATCH_CREATE_FAILED',
          firstFailureCause,
        );
      }
      throw new PartialBatchCreateError({
        createdRecordsByInputIndex,
        failureMessagesByInputIndex,
        cause: firstFailureCause,
      });
    }
    return results;
  }

  /**
   * One create call per record (quotes), but the runner still hands several
   * files at once when the flag is on. If record N fails after records 0..N-1
   * were created, report them through {@link PartialBatchCreateError} so the
   * runner registers their ids instead of re-creating them on its retry.
   */
  private async createRecordsOneAtATime(
    objectType: string,
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
  ): Promise<ConnectorFile[]> {
    const propertyNames = await this.host.getPropertyNames(objectType);
    const associationTypes = this.host.getAssociationTypes(objectType);
    const results: ConnectorFile[] = [];
    const createdRecordsByInputIndex = new Map<number, ConnectorFile>();

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      let createdId: string | undefined;
      try {
        const properties = this.host.extractWritableProperties(file, tableSpec);
        const created = await this.client.createRecord(objectType, properties);
        createdId = created.id;

        const fileAssociations = (file as unknown as HubspotRecord).associations;
        if (fileAssociations) {
          await this.syncAssociations(objectType, created.id, {}, fileAssociations);
        }

        const complete = await this.client.getRecord(objectType, created.id, propertyNames, associationTypes);
        if (!complete) {
          throw new HubspotError(`${objectType}/${created.id} disappeared before it could be refetched`, 404);
        }
        const completeFile = complete as unknown as ConnectorFile;
        createdRecordsByInputIndex.set(index, completeFile);
        results.push(completeFile);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (createdId !== undefined) {
          // Created, but its links or refetch failed: archive it so the retry
          // can create it cleanly instead of next to a half-published copy.
          await this.archiveRecordAfterFailedPublish(objectType, createdId, message);
        }
        if (createdRecordsByInputIndex.size === 0) {
          throw error; // Nothing exists remotely: the ordinary per-record retry is safe.
        }
        const failureMessagesByInputIndex = new Map<number, string>([[index, message]]);
        for (let notAttempted = index + 1; notAttempted < files.length; notAttempted++) {
          failureMessagesByInputIndex.set(
            notAttempted,
            `Not attempted: an earlier record in the batch failed (${message})`,
          );
        }
        throw new PartialBatchCreateError({ createdRecordsByInputIndex, failureMessagesByInputIndex, cause: error });
      }
    }

    return results;
  }

  /**
   * Archive a record this publish created whose later steps (links, refetch)
   * failed, so the op can be reported as failed and re-created cleanly by the
   * runner's per-record retry. Best effort: an archive that fails is logged with
   * the id — the retry may then create a duplicate next to it (a double fault
   * we accept rather than adding a non-retryable state).
   */
  private async archiveRecordAfterFailedPublish(objectType: string, recordId: string, reason: string): Promise<void> {
    try {
      await this.client.deleteRecord(objectType, recordId);
      WSLogger.warn({
        source: LOG_SOURCE,
        message: `Archived ${objectType}/${recordId} after its publish failed post-create; it will be re-created on retry`,
        error: reason,
      });
    } catch (error) {
      WSLogger.error({
        source: LOG_SOURCE,
        message: `Could not archive ${objectType}/${recordId} after its publish failed post-create; it is now orphaned in HubSpot and the retry may duplicate it`,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Archive the records of a batch create whose results could not be bound to
   * their inputs, restoring the pre-call state. Each archive is attempted up to
   * {@link ROLLBACK_ARCHIVE_ATTEMPTS} times (the client already retries 429s);
   * returns the ids that still could not be archived — those records are now
   * orphaned in HubSpot, and the caller must NOT let their inputs be re-created.
   */
  private async rollBackUnmappableCreatedRecords(
    objectType: string,
    unmappableError: HubspotBatchCreateUnmappableError,
  ): Promise<string[]> {
    const idsThatFailedToArchive: string[] = [];
    for (const recordId of unmappableError.createdRecordIds) {
      let archived = false;
      let lastError: unknown;
      for (let attempt = 1; attempt <= ROLLBACK_ARCHIVE_ATTEMPTS && !archived; attempt++) {
        try {
          await this.client.deleteRecord(objectType, recordId);
          archived = true;
        } catch (error) {
          lastError = error;
          if (attempt < ROLLBACK_ARCHIVE_ATTEMPTS) {
            await new Promise((resolve) => setTimeout(resolve, ROLLBACK_ARCHIVE_RETRY_DELAY_MS * attempt));
          }
        }
      }
      if (!archived) {
        idsThatFailedToArchive.push(recordId);
        WSLogger.error({
          source: LOG_SOURCE,
          message: `Failed to roll back unmappable batch-created ${objectType}/${recordId}; it is now orphaned in HubSpot`,
          error: lastError instanceof Error ? lastError.message : String(lastError),
        });
      }
    }
    WSLogger.warn({
      source: LOG_SOURCE,
      message:
        `Rolled back ${unmappableError.createdRecordIds.length - idsThatFailedToArchive.length} of ` +
        `${unmappableError.createdRecordIds.length} unmappable batch-created ${objectType} record(s)` +
        '; the records will be re-created one per call on retry',
      data: { orphanedRecordIds: idsThatFailedToArchive },
    });
    if (idsThatFailedToArchive.length > 0) {
      unmappableError.message +=
        ` Could not roll back (now orphaned in HubSpot, needs manual reconciliation; the retry may duplicate them): ` +
        `[${idsThatFailedToArchive.join(', ')}]`;
    }
    return idsThatFailedToArchive;
  }

  // ---------------------------------------------------------------- updates

  /**
   * Entry point from `HubspotConnector.updateRecords` when the flag is on
   * (every object type but quotes — the connector keeps quotes on its legacy
   * recall-dance loop):
   *
   *  1. one `batch/update` call per {@link HUBSPOT_BATCH_PUBLISH_SIZE} records that
   *     have writable property changes (association-only edits send none);
   *  2. one GET per record whose changeset touches associations (batch read never
   *     returns them), the id-only diff, then one association call per type for
   *     the whole batch ({@link writeAssociationDiffs});
   *  3. the same per-record refetch as the legacy path, so the returned files
   *     are byte-equal to a fresh pull.
   *
   * Error contract: throw-or-succeed. A rejected input or a rejected association
   * pair fails the whole batch with a message naming the records/pairs; the
   * runner then retries record by record, which is safe because updates and
   * association writes are idempotent.
   */
  async updateRecords(
    objectType: string,
    tableSpec: BaseJsonTableSpec,
    files: ConnectorFile[],
    changedFields: (Record<string, unknown> | undefined)[] | undefined,
  ): Promise<ConnectorFile[]> {
    const propertyNames = await this.host.getPropertyNames(objectType);
    const associationTypes = this.host.getAssociationTypes(objectType);

    const writePlans = files.map((file, index) => {
      const cf = changedFields?.[index];
      const shouldSyncAssociations = (!cf || 'associations' in cf) && associationTypes.length > 0;
      return {
        index,
        recordId: String(file.id),
        propertiesToWrite: this.host.computeWritablePropertiesToPublish(file, tableSpec, cf),
        desiredAssociations: shouldSyncAssociations
          ? ((file as unknown as HubspotRecord).associations ?? {})
          : undefined,
      };
    });
    const writtenIndexes = new Set<number>();

    // 1. Property writes, batched.
    const plansWithPropertyWrites = writePlans.filter((plan) => Object.keys(plan.propertiesToWrite).length > 0);
    for (const chunk of chunkArray(plansWithPropertyWrites, HUBSPOT_BATCH_PUBLISH_SIZE)) {
      const inputs = chunk.map((plan, positionInChunk) => ({
        id: plan.recordId,
        objectWriteTraceId: String(positionInChunk),
        properties: plan.propertiesToWrite,
      }));
      const response = await this.client.batchUpdateRecords(objectType, inputs);
      const outcome = mapBatchUpdateResponseToInputs(response, inputs);
      if (outcome.failureMessagesByInputIndex.size > 0) {
        const described = [...outcome.failureMessagesByInputIndex.entries()]
          .map(([positionInChunk, message]) => `${objectType}/${chunk[positionInChunk].recordId}: ${message}`)
          .join('; ');
        throw new HubspotError(
          `HubSpot rejected ${outcome.failureMessagesByInputIndex.size} of ${inputs.length} record update(s): ${described}`,
          207,
          'BATCH_UPDATE_FAILED',
          response,
        );
      }
      for (const plan of chunk) writtenIndexes.add(plan.index);
    }

    // 2. Association diffs against live state, flushed once for the batch.
    const recordDiffs: { recordId: string; diff: HubspotAssociationDiffForRecord }[] = [];
    for (const plan of writePlans) {
      if (plan.desiredAssociations === undefined) continue;
      const currentRecord = await this.client.getRecord(objectType, plan.recordId, propertyNames, associationTypes);
      if (!currentRecord) continue;
      // Conservative: refetch even when the diff is a no-op (same as the legacy path).
      writtenIndexes.add(plan.index);
      const diff = diffAssociationsById(currentRecord.associations ?? {}, plan.desiredAssociations);
      if (!associationDiffIsEmpty(diff)) recordDiffs.push({ recordId: plan.recordId, diff });
    }
    if (recordDiffs.length > 0) {
      await this.writeAssociationDiffs(objectType, recordDiffs);
    }

    // 3. Refetch what was written; echo the input for no-op rows.
    const results = new Array<ConnectorFile>(files.length);
    for (const plan of writePlans) {
      if (!writtenIndexes.has(plan.index)) {
        results[plan.index] = files[plan.index];
        continue;
      }
      const refetched = await this.client.getRecord(objectType, plan.recordId, propertyNames, associationTypes);
      results[plan.index] = (refetched as unknown as ConnectorFile) ?? files[plan.index];
    }
    return results;
  }

  // ----------------------------------------------------------- associations

  /**
   * Entry point from `HubspotConnector.syncAssociations` when the flag is on
   * (used by the legacy quote paths): diff one record's associations by id and
   * write the diff — surfacing failures, unlike the legacy warn-and-swallow.
   * A one-record diff flushes as at most one call per association type, so a
   * quote's writes stay a single awaited call inside its recall window.
   */
  async syncAssociations(
    objectType: string,
    recordId: string,
    current: Record<string, { results: HubspotAssociation[] }>,
    desired: Record<string, { results: HubspotAssociation[] }>,
  ): Promise<void> {
    const diff = diffAssociationsById(current, desired);
    if (associationDiffIsEmpty(diff)) return;
    await this.writeAssociationDiffs(objectType, [{ recordId, diff }]);
  }

  /**
   * Write the association diffs of one or many records of `objectType`.
   *
   * - 2026-03: the diffs are grouped by association type and each group goes
   *   out as ONE `batch/associate/default` (adds) and ONE `batch/archive`
   *   (removes) call carrying every record's pairs.
   * - v4 (the batch endpoints don't exist there): one call per pair.
   *
   * Either way a rejected write is **surfaced**: every group is still
   * attempted, then a {@link HubspotAssociationWriteError} naming each failed
   * `{from → to}` pair fails the publish of the records involved.
   */
  private async writeAssociationDiffs(
    objectType: string,
    recordDiffs: { recordId: string; diff: HubspotAssociationDiffForRecord }[],
  ): Promise<void> {
    const apiVersion = await this.host.getAssociationsApiVersion();
    const grouped = groupAssociationWritesAcrossRecords(recordDiffs);

    if (apiVersion !== '2026-03') {
      if (!this.warnedAboutUnbatchedAssociationWrites) {
        this.warnedAboutUnbatchedAssociationWrites = true;
        WSLogger.warn({
          source: LOG_SOURCE,
          message:
            'HUBSPOT_BATCH_PUBLISH is on but HUBSPOT_ASSOCIATIONS_API_2026_03 is off; the batch association ' +
            'endpoints only exist on 2026-03, so association writes go out one call per pair',
        });
      }
      await this.writeAssociationPairsOneByOne(objectType, grouped, apiVersion);
      return;
    }

    const failedPairs: HubspotFailedAssociationPair[] = [];
    // Raw bodies of the calls that reported failures — kept on the thrown error
    // so the live spec and support logs can see HubSpot's exact shape.
    const responsesWithErrors: unknown[] = [];
    const errorMessageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

    for (const [toObjectType, pairs] of grouped.pairsToCreateByAssociationType) {
      for (const chunk of chunkArray(pairs, HUBSPOT_BATCH_ASSOCIATE_MAX_INPUTS)) {
        try {
          const response = await this.client.batchCreateDefaultAssociations(objectType, toObjectType, chunk);
          const failedPairsInChunk = failedPairsFromBatchAssociationResponse(response, chunk, objectType, toObjectType);
          if (failedPairsInChunk.length > 0) responsesWithErrors.push(response);
          failedPairs.push(...failedPairsInChunk);
        } catch (error) {
          const reason = errorMessageOf(error);
          failedPairs.push(...chunk.map((pair) => ({ ...pair, fromObjectType: objectType, toObjectType, reason })));
        }
      }
    }
    for (const [toObjectType, pairs] of grouped.pairsToArchiveByAssociationType) {
      for (const chunk of chunkArchivePairsByUniqueFromId(pairs, HUBSPOT_BATCH_ARCHIVE_MAX_UNIQUE_FROM_IDS)) {
        try {
          await this.client.batchArchiveAssociations(objectType, toObjectType, chunk);
        } catch (error) {
          const reason = errorMessageOf(error);
          failedPairs.push(...chunk.map((pair) => ({ ...pair, fromObjectType: objectType, toObjectType, reason })));
        }
      }
    }

    if (failedPairs.length > 0) {
      throw new HubspotAssociationWriteError(failedPairs, responsesWithErrors);
    }
  }

  /**
   * One HTTP call per association pair (the v4-era shape), attempting every
   * pair and then throwing {@link HubspotAssociationWriteError} naming the
   * failed ones.
   */
  private async writeAssociationPairsOneByOne(
    objectType: string,
    grouped: ReturnType<typeof groupAssociationWritesAcrossRecords>,
    apiVersion: HubspotAssociationsApiVersion,
  ): Promise<void> {
    const failedPairs: HubspotFailedAssociationPair[] = [];
    const recordFailure = (toObjectType: string, pair: { fromId: string; toId: string }, error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      failedPairs.push({ ...pair, fromObjectType: objectType, toObjectType, reason });
    };

    for (const [toObjectType, pairs] of grouped.pairsToCreateByAssociationType) {
      for (const pair of pairs) {
        try {
          await this.client.createAssociation(objectType, pair.fromId, toObjectType, pair.toId, apiVersion);
        } catch (error) {
          recordFailure(toObjectType, pair, error);
        }
      }
    }
    for (const [toObjectType, pairs] of grouped.pairsToArchiveByAssociationType) {
      for (const pair of pairs) {
        try {
          await this.client.deleteAssociation(objectType, pair.fromId, toObjectType, pair.toId, apiVersion);
        } catch (error) {
          recordFailure(toObjectType, pair, error);
        }
      }
    }

    if (failedPairs.length > 0) {
      throw new HubspotAssociationWriteError(failedPairs);
    }
  }
}

/** Re-exported so the connector's `getBatchSize` and the specs share one constant. */
export { HUBSPOT_BATCH_PUBLISH_SIZE };

/** Type re-export for the connector's doc links. */
export type { HubspotAssociationResult };
