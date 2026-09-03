import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  FileDiffStatus,
  PublishDiffAnchor,
  PublishPlanChangedFile,
  PublishPlanChangedFilesResponse,
  PublishPlanFileDiff,
} from '@spinner/shared-types';
import { PUBLISH_DIFF_ANCHORS } from '@spinner/shared-types';
import cloneDeep from 'lodash/cloneDeep';
import isEqual from 'lodash/isEqual';
import { WSLogger } from 'src/logger';
import {
  FieldValueCanonicalizerMap,
  resolveFieldValueCanonicalizersForTable,
} from 'src/remote-service/connectors/field-value-canonicalization';
import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
import { readFieldValueAtPath, setFieldValueAtPath } from 'src/utils/field-path';
import { DbService } from '../db/db.service';
import { ScratchGitNotFoundError } from '../scratch-git/scratch-git.client';
import { ScratchGitService } from '../scratch-git/scratch-git.service';
import { computeChangedFields } from './diff-utils';
import { SchemaHelperService } from './schema-helper.service';
import { parsePath } from './utils';

const DEFAULT_CHANGED_FILES_PAGE_SIZE = 100;
const MAX_CHANGED_FILES_PAGE_SIZE = 1000;

const DEFAULT_FROM_ANCHOR: PublishDiffAnchor = 'pre-main';
const DEFAULT_TO_ANCHOR: PublishDiffAnchor = 'post-main';

/**
 * The two commits a publish diff spans, resolved from a PublishPlan row and the
 * requested `from` / `to` anchors.
 */
interface PublishPlanCommitRange {
  planId: string;
  connectorAccountId: string | null;
  /** The connection's service (`Service` enum value); `null` when the plan's connection is gone. */
  connectorService: string | null;
  repoId: string;
  from: PublishDiffAnchor;
  to: PublishDiffAnchor;
  baseCommitSha: string | null;
  headCommitSha: string;
}

/**
 * Read-only view of what a publish changed (DEV-11427).
 *
 * A publish run tags and persists three commits on the connection repo: `main`
 * and `dirty` before it starts (`preMainCommitSha` / `preDirtyCommitSha`, tags
 * `main_pre_plan_<id>` / `dirty_plan_<id>`) and `main` after it finishes
 * (`postMainCommitSha`, tag `main_plan_<id>`). Both endpoints here diff any two
 * of those, chosen by the `from` / `to` anchors:
 *
 *   pre-main  → post-main  (default)  what the publish changed live. Rows the
 *                                     connector rejected never reach `main`.
 *   pre-main  → pre-dirty             what was staged ("old vs edits").
 *   pre-dirty → post-main             what the connector changed relative to
 *                                     what we sent (normalisation, computed fields).
 *
 * This is deliberately separate from the plan/operations tables: the plan says
 * what we *intended* to send; the commits say what was staged and what shipped.
 *
 * The per-file diff renders record fields in the connector's CANONICAL form
 * (see `field-value-canonicalization.ts`) on both sides before comparing them,
 * so a value the service merely re-rendered — an Airtable empty field omitted
 * on read, a Postgres timestamp re-spelled, a Notion span decorated — reads as
 * unchanged instead of drowning out the real edits. That rendering is for
 * DISPLAY ONLY: it is lossy by design and never feeds a publish.
 */
@Injectable()
export class PublishPlanDiffService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGitService: ScratchGitService,
    private readonly schemaService: SchemaHelperService,
  ) {}

  /**
   * The files that differ between the two anchors, paginated and optionally
   * filtered to one folder and/or one status. Paths are full workbook paths
   * (leading `/`).
   */
  async listChangedFilesForPublishPlan(
    workbookId: string,
    planId: string,
    options?: {
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
      folderPath?: string;
      status?: string;
    },
  ): Promise<PublishPlanChangedFilesResponse> {
    const statusFilter = parseFileDiffStatusFilterOrThrow(options?.status);
    const commitRange = await this.resolvePublishPlanCommitRange(workbookId, planId, options?.from, options?.to);

    const changedFilesInRepoOrder = await this.scratchGitService
      .compareCommits(commitRange.repoId, commitRange.baseCommitSha, commitRange.headCommitSha)
      .catch((err) => {
        if (err instanceof ScratchGitNotFoundError) {
          throw new NotFoundException(
            `Publish plan ${planId}: a recorded commit no longer exists in the connection repo (${err.responseBody})`,
          );
        }
        throw err;
      });

    const allChangedFilesSortedByPath: PublishPlanChangedFile[] = changedFilesInRepoOrder
      .map((entry) => ({ path: toWorkbookPath(entry.path), status: entry.status }))
      .sort((a, b) => a.path.localeCompare(b.path));

    const counts = { added: 0, modified: 0, deleted: 0 };
    for (const file of allChangedFilesSortedByPath) {
      counts[file.status] += 1;
    }

    const folderPrefixFilter = options?.folderPath ? ensureTrailingSlash(toWorkbookPath(options.folderPath)) : null;
    const filteredChangedFiles = allChangedFilesSortedByPath.filter((file) => {
      if (folderPrefixFilter && !file.path.startsWith(folderPrefixFilter)) return false;
      if (statusFilter && file.status !== statusFilter) return false;
      return true;
    });

    const page = Math.max(options?.page ?? 1, 1);
    const pageSize = Math.min(
      Math.max(options?.pageSize ?? DEFAULT_CHANGED_FILES_PAGE_SIZE, 1),
      MAX_CHANGED_FILES_PAGE_SIZE,
    );
    const pageStartIndex = (page - 1) * pageSize;

    return {
      planId: commitRange.planId,
      connectorAccountId: commitRange.connectorAccountId,
      from: commitRange.from,
      to: commitRange.to,
      baseCommitSha: commitRange.baseCommitSha,
      headCommitSha: commitRange.headCommitSha,
      data: filteredChangedFiles.slice(pageStartIndex, pageStartIndex + pageSize),
      total: filteredChangedFiles.length,
      page,
      pageSize,
      counts,
    };
  }

  /**
   * Content of one record file at the two anchors, plus a sparse field-level
   * diff when both sides are JSON objects. 404s when the file exists at neither
   * anchor.
   *
   * When the connection's connector declares field-value canonicalizers for the
   * file's table, every canonicalized field is replaced by its canonical form on
   * both sides — in the returned `before` / `after` content as well as in the
   * diff — so the response shows the change the service actually holds rather
   * than how it re-rendered the value. `status` still reflects the raw bytes,
   * matching the changed-files list: a file the service only re-rendered is
   * `modified` with an empty `changedFields`.
   */
  async getFileDiffForPublishPlan(
    workbookId: string,
    planId: string,
    filePath: string,
    options?: { from?: string; to?: string },
  ): Promise<PublishPlanFileDiff> {
    if (!filePath) {
      throw new BadRequestException('Query param path is required');
    }
    const commitRange = await this.resolvePublishPlanCommitRange(workbookId, planId, options?.from, options?.to);
    const repoRelativePath = toRepoPath(filePath);

    const [beforeFile, afterFile] = await Promise.all([
      commitRange.baseCommitSha
        ? this.scratchGitService.getRepoFile(commitRange.repoId, commitRange.baseCommitSha, repoRelativePath)
        : Promise.resolve(null),
      this.scratchGitService.getRepoFile(commitRange.repoId, commitRange.headCommitSha, repoRelativePath),
    ]);
    const before = beforeFile?.content ?? null;
    const after = afterFile?.content ?? null;

    if (before === null && after === null) {
      throw new NotFoundException(
        `File ${toWorkbookPath(filePath)} does not exist at ${commitRange.from} or ${commitRange.to} of publish ${planId}`,
      );
    }

    const beforeRecord = parseJsonObjectOrNull(before);
    const afterRecord = parseJsonObjectOrNull(after);

    // The table spec drives both the canonical rendering and the schema-aware
    // diff (keyed arrays, atomic asset fields). Only a JSON record needs it.
    const tableSpec =
      beforeRecord || afterRecord
        ? await this.resolveTableSpecForRecordFile(workbookId, commitRange.connectorAccountId, filePath)
        : null;
    const canonicalizerByFieldPath = resolveFieldValueCanonicalizersForTable(
      commitRange.connectorService ?? '',
      tableSpec,
    );
    const beforeCanonicalRecord = beforeRecord
      ? canonicalizeRecordFieldsForDisplay(beforeRecord, canonicalizerByFieldPath, tableSpec)
      : null;
    const afterCanonicalRecord = afterRecord
      ? canonicalizeRecordFieldsForDisplay(afterRecord, canonicalizerByFieldPath, tableSpec)
      : null;

    return {
      planId: commitRange.planId,
      path: toWorkbookPath(filePath),
      from: commitRange.from,
      to: commitRange.to,
      status: classifyFileDiffStatus(before, after),
      baseCommitSha: commitRange.baseCommitSha,
      headCommitSha: commitRange.headCommitSha,
      before: renderRecordContentForDisplay(before, beforeRecord, beforeCanonicalRecord),
      after: renderRecordContentForDisplay(after, afterRecord, afterCanonicalRecord),
      changedFields:
        beforeCanonicalRecord && afterCanonicalRecord
          ? computeChangedFields(beforeCanonicalRecord, afterCanonicalRecord, tableSpec?.schema ?? null)
          : null,
    };
  }

  /**
   * The table spec (schema.json) of the folder a record file lives in, scoped to
   * the plan's connection so a folder path shared by two connections resolves
   * to the right one. `null` when the folder or its schema cannot be found —
   * the diff then falls back to a plain structural compare of the raw content.
   */
  private async resolveTableSpecForRecordFile(
    workbookId: string,
    connectorAccountId: string | null,
    filePath: string,
  ): Promise<BaseJsonTableSpec | null> {
    const { folderPath } = parsePath(toWorkbookPath(filePath));
    const dataFolderInfo = await this.schemaService.getDataFolderInfo(
      workbookId,
      folderPath,
      undefined,
      connectorAccountId,
    );
    return dataFolderInfo?.spec ?? null;
  }

  /**
   * Load the plan (scoped to the workbook) and resolve the commits at the two
   * requested anchors. Prefers the SHAs persisted on the row; falls back to the
   * git tags the run wrote alongside them, for rows from before the SHAs were
   * recorded.
   *
   * A missing commit at `to` is a 400 (the run has not reached that point, or
   * never recorded it). A missing commit at `from` is tolerated only for
   * `pre-main` — a repo with no prior `main` — and then means the empty tree.
   */
  private async resolvePublishPlanCommitRange(
    workbookId: string,
    planId: string,
    fromAnchorRaw: string | undefined,
    toAnchorRaw: string | undefined,
  ): Promise<PublishPlanCommitRange> {
    const from = parsePublishDiffAnchorOrThrow('from', fromAnchorRaw, DEFAULT_FROM_ANCHOR);
    const to = parsePublishDiffAnchorOrThrow('to', toAnchorRaw, DEFAULT_TO_ANCHOR);
    if (from === to) {
      throw new BadRequestException(`Query params from and to must differ (both are ${from})`);
    }

    const plan = await this.db.client.publishPlan.findFirst({
      where: { id: planId, workbookId },
      select: {
        id: true,
        status: true,
        connectorAccountId: true,
        connectorAccount: { select: { service: true } },
        preMainCommitSha: true,
        preDirtyCommitSha: true,
        postMainCommitSha: true,
      },
    });
    if (!plan) {
      throw new NotFoundException(`Publish plan ${planId} not found in workbook ${workbookId}`);
    }

    const repoId = await this.scratchGitService.resolveConnectionRepoPath(plan.connectorAccountId);

    const resolveAnchorCommitSha = async (anchor: PublishDiffAnchor): Promise<string | null> => {
      switch (anchor) {
        case 'pre-main':
          return (
            plan.preMainCommitSha ?? (await this.scratchGitService.getBranchHead(repoId, `main_pre_plan_${plan.id}`))
          );
        case 'pre-dirty':
          return (
            plan.preDirtyCommitSha ?? (await this.scratchGitService.getBranchHead(repoId, `dirty_plan_${plan.id}`))
          );
        case 'post-main':
          return plan.postMainCommitSha ?? (await this.scratchGitService.getBranchHead(repoId, `main_plan_${plan.id}`));
      }
    };

    const headCommitSha = await resolveAnchorCommitSha(to);
    if (!headCommitSha) {
      throw new BadRequestException(
        to === 'post-main'
          ? `Publish plan ${planId} has no post-publish commit yet (status: ${plan.status}); the diff is available once a run completes`
          : `Publish plan ${planId} recorded no ${to} commit (status: ${plan.status})`,
      );
    }

    const baseCommitSha = await resolveAnchorCommitSha(from);
    if (!baseCommitSha && from !== 'pre-main') {
      throw new BadRequestException(`Publish plan ${planId} recorded no ${from} commit (status: ${plan.status})`);
    }

    return {
      planId: plan.id,
      connectorAccountId: plan.connectorAccountId,
      connectorService: plan.connectorAccount?.service ?? null,
      repoId,
      from,
      to,
      baseCommitSha,
      headCommitSha,
    };
  }
}

function parsePublishDiffAnchorOrThrow(
  paramName: 'from' | 'to',
  raw: string | undefined,
  defaultAnchor: PublishDiffAnchor,
): PublishDiffAnchor {
  if (raw === undefined || raw === '') return defaultAnchor;
  const match = PUBLISH_DIFF_ANCHORS.find((anchor) => anchor === raw);
  if (!match) {
    throw new BadRequestException(
      `Query param ${paramName} must be one of ${PUBLISH_DIFF_ANCHORS.join(', ')} (got "${raw}")`,
    );
  }
  return match;
}

const FILE_DIFF_STATUSES: readonly FileDiffStatus[] = ['added', 'modified', 'deleted'];

function parseFileDiffStatusFilterOrThrow(raw: string | undefined): FileDiffStatus | null {
  if (raw === undefined || raw === '') return null;
  const match = FILE_DIFF_STATUSES.find((status) => status === raw);
  if (!match) {
    throw new BadRequestException(`Query param status must be one of ${FILE_DIFF_STATUSES.join(', ')} (got "${raw}")`);
  }
  return match;
}

/** `Companies/rec.json` → `/Companies/rec.json` (the workbook's full-path convention). */
function toWorkbookPath(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

/** `/Companies/rec.json` → `Companies/rec.json` (what the git service expects). */
function toRepoPath(path: string): string {
  return path.startsWith('/') ? path.substring(1) : path;
}

function ensureTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
}

function classifyFileDiffStatus(before: string | null, after: string | null): FileDiffStatus | 'unchanged' {
  if (before === null) return 'added';
  if (after === null) return 'deleted';
  return before === after ? 'unchanged' : 'modified';
}

/**
 * A copy of `record` in which every field the connector declares a canonicalizer
 * for holds its canonical form instead of the stored value. Fields without a
 * canonicalizer, and fields whose canonical form already equals the stored value,
 * are left as they are. An absent field whose canonical form is a value (e.g.
 * Airtable's omitted-on-read empty field → `null`) is materialised, so both
 * sides of the diff spell "empty" the same way.
 *
 * Display only: the canonical form is lossy (numbers rounded, instants reduced
 * to epoch milliseconds, rich text flattened) and must never be written back or
 * fed into a publish. A canonicalizer that throws leaves its field as stored.
 */
function canonicalizeRecordFieldsForDisplay(
  record: Record<string, unknown>,
  canonicalizerByFieldPath: FieldValueCanonicalizerMap,
  tableSpec: BaseJsonTableSpec | null,
): Record<string, unknown> {
  if (canonicalizerByFieldPath.size === 0) return record;

  const canonicalRecord = cloneDeep(record);
  for (const [fieldPath, canonicalizer] of canonicalizerByFieldPath) {
    const storedValue = readFieldValueAtPath(canonicalRecord, fieldPath);
    let canonicalValue: unknown;
    try {
      canonicalValue = canonicalizer(storedValue);
    } catch (error) {
      WSLogger.warn({
        source: 'PublishPlanDiffService.canonicalizeRecordFieldsForDisplay',
        message: `Field-value canonicalizer for ${fieldPath} threw; showing the stored value`,
        error,
      });
      continue;
    }
    if (canonicalValue === undefined || isEqual(canonicalValue, storedValue)) continue;
    setFieldValueAtPath(canonicalRecord, fieldPath, canonicalValue, tableSpec?.schema);
  }
  return canonicalRecord;
}

/**
 * The content to return for one side of the diff: the raw file content when
 * nothing was canonicalized (byte-for-byte what is in git), otherwise the
 * canonical record pretty-printed. `parsedRecord` is `null` when the raw
 * content is missing or is not a JSON object.
 */
function renderRecordContentForDisplay(
  rawContent: string | null,
  parsedRecord: Record<string, unknown> | null,
  canonicalRecord: Record<string, unknown> | null,
): string | null {
  if (rawContent === null || parsedRecord === null || canonicalRecord === null) return rawContent;
  if (canonicalRecord === parsedRecord || isEqual(canonicalRecord, parsedRecord)) return rawContent;
  return JSON.stringify(canonicalRecord, null, 2);
}

function parseJsonObjectOrNull(content: string | null): Record<string, unknown> | null {
  if (content === null) return null;
  try {
    const parsed: unknown = JSON.parse(content);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}
