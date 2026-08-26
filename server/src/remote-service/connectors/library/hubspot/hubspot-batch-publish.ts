import { HubspotError } from './hubspot-api-client';
import {
  HubspotAssociationResult,
  HubspotBatchAssociationResponse,
  HubspotBatchInputError,
  HubspotBatchWriteResponse,
  HubspotBatchWriteResult,
  HubspotRecord,
} from './hubspot-types';

// --- Batched publishing (DEV-10200, HUBSPOT_BATCH_PUBLISH) ---------------------
//
// Pure helpers behind the HubSpot connector's batched publish path: the
// id-only association diff, the cross-record grouping of association writes,
// chunking, and the parsing of HubSpot's 207 Multi-Status batch responses. No
// I/O here — everything is unit-testable in isolation.

/**
 * How many records one publish batch carries when `HUBSPOT_BATCH_PUBLISH` is on.
 * HubSpot's batch create/update endpoints accept 100 inputs per call; we cap at
 * 10 to keep the blast radius of a partial failure small and each batch of
 * association writes (one call per association type) cheap to attribute.
 */
export const HUBSPOT_BATCH_PUBLISH_SIZE = 10;

/** HubSpot's own cap on inputs per `batch/create` / `batch/update` call. */
export const HUBSPOT_BATCH_WRITE_MAX_INPUTS = 100;

/** HubSpot's cap on `{from, to}` pairs per `batch/associate/default` call (2026-03). */
export const HUBSPOT_BATCH_ASSOCIATE_MAX_INPUTS = 2000;

/** HubSpot's cap on unique `from` ids per `batch/archive` call (2026-03). */
export const HUBSPOT_BATCH_ARCHIVE_MAX_UNIQUE_FROM_IDS = 100;

/** A directed default association between two records. */
export interface HubspotAssociationPair {
  fromId: string;
  toId: string;
}

/**
 * The id-only association diff for one record: the ids to link and unlink per
 * association type (the `to` object type, e.g. `companies`).
 */
export interface HubspotAssociationDiffForRecord {
  toCreateIdsByAssociationType: Map<string, string[]>;
  toDeleteIdsByAssociationType: Map<string, string[]>;
}

/**
 * Diff a record's current vs desired associations **by id only**, per
 * association type. This is THE association diff: `syncAssociations` writes
 * exactly what it returns, and the e-sign guard
 * (`associationSyncWouldCreateOrDelete`) answers "would a write fire?" by
 * asking whether it is empty — so the two can never drift apart. Labels are
 * ignored (the known DEV-10902 gap): a desired id that already exists remotely
 * is left untouched, whatever its labels.
 */
export function diffAssociationsById(
  current: Record<string, HubspotAssociationResult>,
  desired: Record<string, HubspotAssociationResult>,
): HubspotAssociationDiffForRecord {
  const toCreateIdsByAssociationType = new Map<string, string[]>();
  const toDeleteIdsByAssociationType = new Map<string, string[]>();
  const allAssociationTypes = new Set([...Object.keys(current), ...Object.keys(desired)]);

  for (const associationType of allAssociationTypes) {
    const currentIds = new Set((current[associationType]?.results ?? []).map((association) => association.id));
    const desiredIds = new Set((desired[associationType]?.results ?? []).map((association) => association.id));

    const idsToCreate = [...desiredIds].filter((id) => !currentIds.has(id));
    const idsToDelete = [...currentIds].filter((id) => !desiredIds.has(id));
    if (idsToCreate.length > 0) toCreateIdsByAssociationType.set(associationType, idsToCreate);
    if (idsToDelete.length > 0) toDeleteIdsByAssociationType.set(associationType, idsToDelete);
  }

  return { toCreateIdsByAssociationType, toDeleteIdsByAssociationType };
}

/** Whether the diff would fire at least one association write. */
export function associationDiffIsEmpty(diff: HubspotAssociationDiffForRecord): boolean {
  return diff.toCreateIdsByAssociationType.size === 0 && diff.toDeleteIdsByAssociationType.size === 0;
}

/** The association writes of every record in a batch, grouped by (association type, operation). */
export interface HubspotGroupedAssociationWrites {
  pairsToCreateByAssociationType: Map<string, HubspotAssociationPair[]>;
  pairsToArchiveByAssociationType: Map<string, HubspotAssociationPair[]>;
}

/**
 * Merge the per-record diffs of a batch into one list of `{from, to}` pairs per
 * (association type, create|archive), so each group can go out as a single
 * batch call carrying every record's links for that type. Pair order follows
 * the input order (records first, then each record's ids), which keeps the
 * calls deterministic and the fake's assertions stable.
 */
export function groupAssociationWritesAcrossRecords(
  recordDiffs: { recordId: string; diff: HubspotAssociationDiffForRecord }[],
): HubspotGroupedAssociationWrites {
  const pairsToCreateByAssociationType = new Map<string, HubspotAssociationPair[]>();
  const pairsToArchiveByAssociationType = new Map<string, HubspotAssociationPair[]>();

  const appendPairs = (
    groupedPairs: Map<string, HubspotAssociationPair[]>,
    recordId: string,
    idsByAssociationType: Map<string, string[]>,
  ) => {
    for (const [associationType, toIds] of idsByAssociationType) {
      const pairsForType = groupedPairs.get(associationType) ?? [];
      for (const toId of toIds) {
        pairsForType.push({ fromId: recordId, toId });
      }
      groupedPairs.set(associationType, pairsForType);
    }
  };

  for (const { recordId, diff } of recordDiffs) {
    appendPairs(pairsToCreateByAssociationType, recordId, diff.toCreateIdsByAssociationType);
    appendPairs(pairsToArchiveByAssociationType, recordId, diff.toDeleteIdsByAssociationType);
  }

  return { pairsToCreateByAssociationType, pairsToArchiveByAssociationType };
}

/** Split `items` into consecutive chunks of at most `chunkSize` (the last one may be shorter). */
export function chunkArray<T>(items: readonly T[], chunkSize: number): T[][] {
  if (chunkSize <= 0) throw new Error(`chunkSize must be positive, got ${chunkSize}`);
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += chunkSize) {
    chunks.push(items.slice(start, start + chunkSize));
  }
  return chunks;
}

/**
 * Chunk archive pairs by HubSpot's "≤ N unique `from` ids per call" rule (not by
 * pair count): every pair sharing a `from` id lands in the same chunk, and a
 * chunk holds at most `maxUniqueFromIds` distinct `from` ids.
 */
export function chunkArchivePairsByUniqueFromId(
  pairs: readonly HubspotAssociationPair[],
  maxUniqueFromIds: number,
): HubspotAssociationPair[][] {
  const pairsByFromId = new Map<string, HubspotAssociationPair[]>();
  for (const pair of pairs) {
    const pairsForFrom = pairsByFromId.get(pair.fromId) ?? [];
    pairsForFrom.push(pair);
    pairsByFromId.set(pair.fromId, pairsForFrom);
  }
  return chunkArray([...pairsByFromId.values()], maxUniqueFromIds).map((groups) => groups.flat());
}

/** Render one batch error into a single human-readable line (category + message + context ids). */
export function describeBatchInputError(error: HubspotBatchInputError): string {
  const contextSummary = error.context
    ? Object.entries(error.context)
        .map(([key, values]) => `${key}=${values.join(',')}`)
        .join(' ')
    : '';
  const parts = [error.category, error.message, contextSummary ? `(${contextSummary})` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(': ').replace(': (', ' (') : 'no reason given';
}

/** The input indexes (parsed from `objectWriteTraceId`) a batch error names, if any. */
function inputIndexesNamedByError(error: HubspotBatchInputError): number[] {
  return (error.context?.objectWriteTraceId ?? [])
    .map((traceId) => Number.parseInt(traceId, 10))
    .filter((index) => Number.isInteger(index) && index >= 0);
}

/** The record ids a batch error names via HubSpot's `ids` / `id` context keys, if any. */
function recordIdsNamedByError(error: HubspotBatchInputError): string[] {
  return [...(error.context?.ids ?? []), ...(error.context?.id ?? [])];
}

/** Outcome of one batch create/update call, mapped back onto the request's input indexes. */
export interface HubspotBatchWriteOutcome {
  /** Records HubSpot confirmed, keyed by the input index they were created/updated for. */
  recordsByInputIndex: Map<number, HubspotRecord>;
  /** Inputs HubSpot rejected, with the reason. */
  failureMessagesByInputIndex: Map<number, string>;
}

/**
 * Normalize a property value for matching a sent input against the record
 * HubSpot echoes back. HubSpot lower-cases emails, trims, re-renders numbers
 * (`"12.50"` → `"12.5"`) and may re-render timestamps, so compare numbers as
 * numbers, parseable dates as epoch millis, and everything else trimmed and
 * lower-cased. Empty / null values are "unset" (undefined) on both sides.
 */
export function normalizePropertyValueForMatching(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined;
  // HubSpot property values are scalars; anything else can only be compared structurally.
  const text = (typeof value === 'string' ? value : JSON.stringify(value)).trim();
  if (text === '') return undefined;
  if (/^-?\d+(\.\d+)?$/.test(text)) return String(Number(text));
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const epochMs = Date.parse(text);
    if (!Number.isNaN(epochMs)) return `t:${epochMs}`;
  }
  return text.toLowerCase();
}

/** How a sent value is compared with the value HubSpot echoed back. */
type EchoedValueComparator = (sentValue: unknown, echoedValue: unknown) => boolean;

/** Exact comparison: the echoed value is the sent value, character for character (trimmed). */
const echoedValueEqualsExactly: EchoedValueComparator = (sentValue, echoedValue) =>
  echoedValue !== null &&
  echoedValue !== undefined &&
  scalarToString(sentValue).trim() === scalarToString(echoedValue).trim();

/** HubSpot property values are scalars; anything else is compared by its JSON form. */
function scalarToString(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

/** Normalized comparison, for values HubSpot re-renders (email case, number rendering, timestamps). */
const echoedValueEqualsNormalized: EchoedValueComparator = (sentValue, echoedValue) =>
  normalizePropertyValueForMatching(sentValue) === normalizePropertyValueForMatching(echoedValue);

/**
 * Whether the record HubSpot returned could be the one created for `sentProperties`:
 * every property we sent with a value is echoed back with an equal value (per
 * `compare`). A property that NO record in the response echoes (`unechoedKeys`)
 * is ignored — it can't tell inputs apart either way — but a property that other
 * records do echo and this one lacks is a mismatch, so a record can never be
 * bound to an input that carries values it doesn't show.
 */
function createdRecordIsCompatibleWithInput(
  sentProperties: Record<string, unknown>,
  record: HubspotRecord,
  unechoedKeys: ReadonlySet<string>,
  compare: EchoedValueComparator,
): boolean {
  for (const [propertyName, sentValue] of Object.entries(sentProperties)) {
    if (normalizePropertyValueForMatching(sentValue) === undefined) continue; // nothing sent
    if (unechoedKeys.has(propertyName)) continue;
    if (!compare(sentValue, record.properties?.[propertyName])) return false;
  }
  return true;
}

/**
 * The exact, non-empty values an input sent, as a canonical string — **every**
 * sent property, echoed or not, so two inputs count as "identical" only when
 * HubSpot would have created identical records from them (`"001"` and `"1"`
 * are different; so are two inputs differing only in a property HubSpot
 * happens not to echo).
 */
function fingerprintOfSentProperties(sentProperties: Record<string, unknown>): string {
  return Object.entries(sentProperties)
    .filter(([, value]) => normalizePropertyValueForMatching(value) !== undefined)
    .map(([key, value]) => `${key}=${scalarToString(value).trim()}`)
    .sort()
    .join('\u0000');
}

/**
 * Bind the records of a batch **create** response to their inputs by the
 * `objectWriteTraceId` HubSpot echoes on each result (live-verified: 201 and
 * 207, every object type). Returns the binding only when it is complete and
 * unambiguous — every result carries a trace id that names a distinct
 * unrejected input — else `undefined`, and the caller falls back to
 * {@link matchCreatedRecordsToInputs}.
 */
export function bindCreatedRecordsByEchoedTraceId(
  inputs: readonly { objectWriteTraceId?: string }[],
  unrejectedInputIndexes: ReadonlySet<number>,
  records: readonly HubspotBatchWriteResult[],
): Map<number, HubspotRecord> | undefined {
  const inputIndexByTraceId = new Map<string, number>();
  for (const [index, input] of inputs.entries()) {
    if (input.objectWriteTraceId === undefined || inputIndexByTraceId.has(input.objectWriteTraceId)) return undefined;
    inputIndexByTraceId.set(input.objectWriteTraceId, index);
  }
  const recordsByInputIndex = new Map<number, HubspotRecord>();
  for (const record of records) {
    const inputIndex =
      record.objectWriteTraceId === undefined ? undefined : inputIndexByTraceId.get(record.objectWriteTraceId);
    if (inputIndex === undefined || !unrejectedInputIndexes.has(inputIndex) || recordsByInputIndex.has(inputIndex)) {
      return undefined;
    }
    recordsByInputIndex.set(inputIndex, record);
  }
  if (recordsByInputIndex.size !== unrejectedInputIndexes.size) return undefined;
  // Input order, whatever order HubSpot returned the records in.
  return new Map([...recordsByInputIndex.entries()].sort(([indexA], [indexB]) => indexA - indexB));
}

/**
 * Match the records of a batch **create** response to the inputs they were
 * created for by the property values HubSpot echoes back — the fallback for a
 * response whose results carry no usable `objectWriteTraceId`
 * ({@link bindCreatedRecordsByEchoedTraceId}); HubSpot does NOT return results
 * in input order (the live spec observed reverse order).
 *
 * Two passes: first with **exact** value equality (a `"001"` never binds to a
 * `"1"` record, `"Acme"` never to `"acme"`), then — only if no exact perfect
 * matching exists — with the normalized comparison that absorbs HubSpot's
 * own rewrites (email lower-casing, number rendering, timestamp rendering).
 * Either pass must produce a perfect matching in which every input is
 * compatible with its record ({@link createdRecordIsCompatibleWithInput}),
 * and that matching must be **unique up to identical inputs**: no other
 * perfect matching may give an input a record outside the set its
 * identical-fingerprint group already holds ({@link matchingIsAmbiguous}).
 * Inputs with identical exact sent values may take either of their records —
 * those records are identical at this point, so any choice is correct.
 * Returns `undefined` when no unambiguous binding exists; the caller rolls
 * the records back. A single input ↔ single record needs no fingerprint.
 */
export function matchCreatedRecordsToInputs(
  sentPropertiesByInputIndex: ReadonlyMap<number, Record<string, unknown>>,
  records: readonly HubspotRecord[],
): Map<number, HubspotRecord> | undefined {
  const inputIndexes = [...sentPropertiesByInputIndex.keys()];
  if (inputIndexes.length !== records.length) return undefined;
  if (inputIndexes.length === 1) return new Map([[inputIndexes[0], records[0]]]);

  const sentKeys = new Set(inputIndexes.flatMap((index) => Object.keys(sentPropertiesByInputIndex.get(index) ?? {})));
  const unechoedKeys = new Set(
    [...sentKeys].filter((key) => records.every((record) => !(key in (record.properties ?? {})))),
  );
  const sentProperties = (position: number) => sentPropertiesByInputIndex.get(inputIndexes[position]) ?? {};
  const fingerprints = inputIndexes.map((_, position) => fingerprintOfSentProperties(sentProperties(position)));

  for (const compare of [echoedValueEqualsExactly, echoedValueEqualsNormalized]) {
    const compatible = inputIndexes.map((_, position) =>
      records.map((record) =>
        createdRecordIsCompatibleWithInput(sentProperties(position), record, unechoedKeys, compare),
      ),
    );
    const recordPositionOfInput = findPerfectMatching(compatible, records.length);
    if (!recordPositionOfInput) continue;
    if (matchingIsAmbiguous(compatible, recordPositionOfInput, fingerprints)) return undefined;

    const matched = new Map<number, HubspotRecord>();
    inputIndexes.forEach((inputIndex, position) => matched.set(inputIndex, records[recordPositionOfInput[position]]));
    return matched;
  }
  return undefined;
}

/**
 * Whether some OTHER perfect matching would give an input a record outside the
 * set of records its identical-fingerprint group holds in `matching`. Checked
 * by forcing each input onto each such record and asking whether the rest can
 * still be perfectly matched — catches swaps and longer alternating cycles
 * alike. Batches are ≤ 10 inputs, so the cost is negligible.
 */
function matchingIsAmbiguous(
  compatible: readonly (readonly boolean[])[],
  matching: readonly number[],
  fingerprints: readonly string[],
): boolean {
  const recordPositionsHeldByFingerprint = new Map<string, Set<number>>();
  fingerprints.forEach((fingerprint, inputPosition) => {
    const held = recordPositionsHeldByFingerprint.get(fingerprint) ?? new Set<number>();
    held.add(matching[inputPosition]);
    recordPositionsHeldByFingerprint.set(fingerprint, held);
  });
  for (let inputPosition = 0; inputPosition < compatible.length; inputPosition++) {
    const held = recordPositionsHeldByFingerprint.get(fingerprints[inputPosition]) as Set<number>;
    for (let recordPosition = 0; recordPosition < compatible[inputPosition].length; recordPosition++) {
      if (held.has(recordPosition) || !compatible[inputPosition][recordPosition]) continue;
      if (findPerfectMatching(compatible, compatible[inputPosition].length, { inputPosition, recordPosition }))
        return true;
    }
  }
  return false;
}

/**
 * Kuhn's augmenting-path bipartite matching: input position → record position,
 * or undefined if no perfect matching exists. `forced` pins one input to one
 * record before matching the rest (used by {@link matchingIsAmbiguous}).
 */
function findPerfectMatching(
  compatible: readonly (readonly boolean[])[],
  recordCount: number,
  forced?: { inputPosition: number; recordPosition: number },
): number[] | undefined {
  const inputAssignedToRecordPosition = new Array<number>(recordCount).fill(-1);
  if (forced) inputAssignedToRecordPosition[forced.recordPosition] = forced.inputPosition;
  const tryAssign = (inputPosition: number, visited: boolean[]): boolean => {
    for (let recordPosition = 0; recordPosition < recordCount; recordPosition++) {
      if (!compatible[inputPosition][recordPosition] || visited[recordPosition]) continue;
      if (forced && recordPosition === forced.recordPosition) continue; // pinned, never reassigned
      visited[recordPosition] = true;
      const currentHolder = inputAssignedToRecordPosition[recordPosition];
      if (currentHolder === -1 || tryAssign(currentHolder, visited)) {
        inputAssignedToRecordPosition[recordPosition] = inputPosition;
        return true;
      }
    }
    return false;
  };
  for (let inputPosition = 0; inputPosition < compatible.length; inputPosition++) {
    if (forced && inputPosition === forced.inputPosition) continue;
    if (!tryAssign(inputPosition, new Array<boolean>(recordCount).fill(false))) return undefined;
  }
  const recordPositionOfInput = new Array<number>(compatible.length).fill(-1);
  inputAssignedToRecordPosition.forEach((inputPosition, recordPosition) => {
    if (inputPosition !== -1) recordPositionOfInput[inputPosition] = recordPosition;
  });
  return recordPositionOfInput;
}

/**
 * Thrown when a batch create's records cannot be bound to their inputs. Carries
 * the ids HubSpot created so the caller can roll them back (archive) before
 * the per-record retry re-creates them one at a time.
 */
export class HubspotBatchCreateUnmappableError extends HubspotError {
  public readonly createdRecordIds: readonly string[];

  constructor(message: string, createdRecordIds: readonly string[], responseData?: unknown) {
    super(message, 207, 'BATCH_CREATE_UNMAPPABLE', responseData);
    this.name = 'HubspotBatchCreateUnmappableError';
    this.createdRecordIds = createdRecordIds;
  }
}

/**
 * Map a batch **create** response back onto its inputs. The request carried
 * `objectWriteTraceId = String(inputIndex)` on every input, which is what makes
 * HubSpot answer 207 (instead of rejecting the whole batch) and name the failed
 * inputs in `errors[].context.objectWriteTraceId`. The created records are
 * then bound to the unrejected inputs by the trace id HubSpot echoes on each
 * result ({@link bindCreatedRecordsByEchoedTraceId}), falling back to the
 * property values it echoes ({@link matchCreatedRecordsToInputs}) — never by
 * position, since HubSpot returns them in arbitrary order. When the counts don't line up or no
 * unambiguous binding exists, throws {@link HubspotBatchCreateUnmappableError}
 * naming the created ids (a wrong binding would tie a file to someone else's
 * record; the caller rolls the records back instead).
 */
export function mapBatchCreateResponseToInputs(
  response: HubspotBatchWriteResponse,
  inputs: readonly { properties: Record<string, unknown>; objectWriteTraceId?: string }[],
): HubspotBatchWriteOutcome {
  if (response.status !== 'COMPLETE') {
    // A non-terminal status: whatever the body lists is rolled back by the
    // caller and the inputs are retried one per call. (HubSpot answers
    // COMPLETE synchronously in practice; a batch that later completes on its
    // own could still duplicate — accepted, logged.)
    throw new HubspotBatchCreateUnmappableError(
      `HubSpot batch create did not complete (status ${JSON.stringify(response.status)}); the outcome of its inputs is unknown`,
      (response.results ?? []).map((record) => record.id),
      response,
    );
  }
  const inputCount = inputs.length;
  const failureMessagesByInputIndex = new Map<number, string>();
  const unattributedErrorMessages: string[] = [];
  const reportedErrorCount = response.numErrors ?? 0;
  const listedErrorCount = response.errors?.length ?? 0;
  if (reportedErrorCount > listedErrorCount) {
    unattributedErrorMessages.push(`HubSpot reported ${reportedErrorCount} error(s) but listed ${listedErrorCount}`);
  }
  for (const error of response.errors ?? []) {
    const namedIndexes = inputIndexesNamedByError(error).filter((index) => index < inputCount);
    if (namedIndexes.length === 0) {
      unattributedErrorMessages.push(describeBatchInputError(error));
      continue;
    }
    for (const index of namedIndexes) {
      failureMessagesByInputIndex.set(index, describeBatchInputError(error));
    }
  }

  const sentPropertiesByUnrejectedInputIndex = new Map<number, Record<string, unknown>>();
  inputs.forEach((input, index) => {
    if (!failureMessagesByInputIndex.has(index)) sentPropertiesByUnrejectedInputIndex.set(index, input.properties);
  });

  const results = response.results ?? [];
  const createdRecordIds = results.map((record) => record.id);
  if (results.length !== sentPropertiesByUnrejectedInputIndex.size || reportedErrorCount > listedErrorCount) {
    throw new HubspotBatchCreateUnmappableError(
      `HubSpot batch create returned ${results.length} record(s) for ${sentPropertiesByUnrejectedInputIndex.size} ` +
        `unrejected input(s) of ${inputCount}; cannot safely match records to files. Created HubSpot ids: ` +
        `[${createdRecordIds.join(', ')}]` +
        (unattributedErrorMessages.length > 0 ? `. Errors: ${unattributedErrorMessages.join('; ')}` : ''),
      createdRecordIds,
      response,
    );
  }

  const recordsByInputIndex =
    bindCreatedRecordsByEchoedTraceId(inputs, new Set(sentPropertiesByUnrejectedInputIndex.keys()), results) ??
    matchCreatedRecordsToInputs(sentPropertiesByUnrejectedInputIndex, results);
  if (!recordsByInputIndex) {
    throw new HubspotBatchCreateUnmappableError(
      `HubSpot batch create returned ${results.length} record(s) whose properties do not match the inputs ` +
        `unambiguously; cannot safely match records to files. Created HubSpot ids: [${createdRecordIds.join(', ')}]`,
      createdRecordIds,
      response,
    );
  }
  return { recordsByInputIndex, failureMessagesByInputIndex };
}

/**
 * Map a batch **update** response back onto its inputs. Updated records carry
 * their `id`, so successes are matched by id (order-independent). An input
 * whose id is missing from `results` failed; its reason comes from the error
 * naming its trace id or its id, else from the batch's first error.
 */
export function mapBatchUpdateResponseToInputs(
  response: HubspotBatchWriteResponse,
  inputs: readonly { id: string }[],
): HubspotBatchWriteOutcome {
  if (response.status !== 'COMPLETE') {
    // Idempotent operation: failing every input makes the per-record retry re-apply it.
    const reason = `HubSpot batch update did not complete (status ${JSON.stringify(response.status)})`;
    return {
      recordsByInputIndex: new Map(),
      failureMessagesByInputIndex: new Map(inputs.map((_, index) => [index, reason])),
    };
  }
  const resultsById = new Map((response.results ?? []).map((record) => [record.id, record]));
  const errors = response.errors ?? [];

  const failureMessageByInputIndexFromTrace = new Map<number, string>();
  const failureMessageByRecordId = new Map<string, string>();
  for (const error of errors) {
    const description = describeBatchInputError(error);
    for (const index of inputIndexesNamedByError(error)) failureMessageByInputIndexFromTrace.set(index, description);
    for (const recordId of recordIdsNamedByError(error)) failureMessageByRecordId.set(recordId, description);
  }

  const recordsByInputIndex = new Map<number, HubspotRecord>();
  const failureMessagesByInputIndex = new Map<number, string>();
  inputs.forEach((input, index) => {
    const updatedRecord = resultsById.get(input.id);
    if (updatedRecord) {
      recordsByInputIndex.set(index, updatedRecord);
      return;
    }
    failureMessagesByInputIndex.set(
      index,
      failureMessageByInputIndexFromTrace.get(index) ??
        failureMessageByRecordId.get(input.id) ??
        (errors[0]
          ? describeBatchInputError(errors[0])
          : 'HubSpot did not return the record in its batch update response'),
    );
  });

  return { recordsByInputIndex, failureMessagesByInputIndex };
}

/** One association write HubSpot rejected. */
export interface HubspotFailedAssociationPair extends HubspotAssociationPair {
  fromObjectType: string;
  toObjectType: string;
  reason: string;
}

/**
 * Thrown when one or more association writes were rejected. Names every failed
 * `{from → to}` pair so the publish error tells the user which links did not
 * land, and so the batched create path can attribute the failure to the exact
 * records (by `fromId`) whose links are missing.
 */
export class HubspotAssociationWriteError extends HubspotError {
  public readonly failedPairs: readonly HubspotFailedAssociationPair[];

  constructor(failedPairs: readonly HubspotFailedAssociationPair[], responseData?: unknown) {
    const described = failedPairs
      .map((pair) => `${pair.fromObjectType}/${pair.fromId} → ${pair.toObjectType}/${pair.toId} (${pair.reason})`)
      .join('; ');
    super(
      `HubSpot rejected ${failedPairs.length} association write(s): ${described}`,
      undefined,
      'ASSOCIATION_WRITE_FAILED',
      responseData,
    );
    this.name = 'HubspotAssociationWriteError';
    this.failedPairs = failedPairs;
  }
}

/** `context` keys HubSpot may use to name the `from` / `to` side of a failed association pair. */
const ASSOCIATION_ERROR_FROM_CONTEXT_KEYS = ['fromObjectId', 'fromObjectIds', 'fromId', 'fromIds', 'from'];
const ASSOCIATION_ERROR_TO_CONTEXT_KEYS = ['toObjectId', 'toObjectIds', 'toId', 'toIds', 'to'];

/**
 * Attribute the errors of a `batch/associate/default` response to the pairs
 * that were sent. HubSpot documents the error `context` only as a map of string
 * arrays. When the context names both a `from` and a `to` side, a pair fails
 * only if **both** its ids are named (an error on `R1→C` must not blame
 * `R2→C`); when it names one side, pairs on that side fail; when it uses keys
 * we don't recognize, any sent id it mentions marks the pair; an error naming
 * no sent id at all is attributed to **every** pair in the call. A response
 * whose `status` is not `COMPLETE`, or that reports more errors (`numErrors`)
 * than it lists, fails every pair too — conservative on purpose: a record
 * marked failed is re-synced on retry, whereas a link silently assumed written
 * is the bug this flag exists to stop.
 */
export function failedPairsFromBatchAssociationResponse(
  response: HubspotBatchAssociationResponse,
  sentPairs: readonly HubspotAssociationPair[],
  fromObjectType: string,
  toObjectType: string,
): HubspotFailedAssociationPair[] {
  const failedPairsByKey = new Map<string, HubspotFailedAssociationPair>();
  const markFailed = (pair: HubspotAssociationPair, reason: string) => {
    const key = `${pair.fromId}→${pair.toId}`;
    if (!failedPairsByKey.has(key)) failedPairsByKey.set(key, { ...pair, fromObjectType, toObjectType, reason });
  };
  const markAllFailed = (reason: string) => {
    for (const pair of sentPairs) markFailed(pair, reason);
  };

  if (response.status !== 'COMPLETE') {
    markAllFailed(`HubSpot batch association call did not complete (status ${JSON.stringify(response.status)})`);
    return [...failedPairsByKey.values()];
  }
  const listedErrors = response.errors ?? [];
  if ((response.numErrors ?? 0) > listedErrors.length) {
    markAllFailed(`HubSpot reported ${response.numErrors} association error(s) but listed ${listedErrors.length}`);
  }

  for (const error of listedErrors) {
    const reason = describeBatchInputError(error);
    const context = error.context ?? {};
    const idsUnder = (keys: readonly string[]) => new Set(keys.flatMap((key) => context[key] ?? []));
    const fromIds = idsUnder(ASSOCIATION_ERROR_FROM_CONTEXT_KEYS);
    const toIds = idsUnder(ASSOCIATION_ERROR_TO_CONTEXT_KEYS);
    let pairsNamed: HubspotAssociationPair[];
    if (fromIds.size > 0 && toIds.size > 0) {
      pairsNamed = sentPairs.filter((pair) => fromIds.has(pair.fromId) && toIds.has(pair.toId));
    } else if (fromIds.size > 0) {
      pairsNamed = sentPairs.filter((pair) => fromIds.has(pair.fromId));
    } else if (toIds.size > 0) {
      pairsNamed = sentPairs.filter((pair) => toIds.has(pair.toId));
    } else {
      const anyIds = new Set(Object.values(context).flat());
      pairsNamed = sentPairs.filter((pair) => anyIds.has(pair.fromId) || anyIds.has(pair.toId));
    }
    for (const pair of pairsNamed.length > 0 ? pairsNamed : sentPairs) markFailed(pair, reason);
  }

  return [...failedPairsByKey.values()];
}
