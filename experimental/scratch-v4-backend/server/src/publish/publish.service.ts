import { Injectable } from '@nestjs/common';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { ConnectorsService } from 'src/remote-service/connectors/connectors.service';
import { Connector } from 'src/remote-service/connectors/connector';
import { BaseJsonTableSpec, ConnectorFile } from 'src/remote-service/connectors/types';
import { ScratchGitClient } from 'src/scratch-git/scratch-git.client';
import { JsonSafeObject } from 'src/utils/objects';
import { Service } from 'src/types/shared-types';

// ---------------------------------------------------------------------------
// Types matching the Rust plan.json format (camelCase from serde)
// ---------------------------------------------------------------------------

interface PlanMeta {
  planId: string;
  createdAt: string;
  connectionName: string;
  connectionId: string;
  summary: { edit: number; create: number; delete: number; backfill: number; rename: number };
  /** relPath → remoteId for deleted files */
  deleteIndex: Record<string, string>;
  /** relPath → sparse changed-fields object */
  changedFields: Record<string, Record<string, unknown>>;
  /** phase → list of relPaths in that phase */
  entries: Record<string, string[]>;
}

type Phase = 'edit' | 'create' | 'delete' | 'backfill' | 'rename';

const PHASE_ORDER: Phase[] = ['edit', 'create', 'delete', 'backfill', 'rename'];

// ---------------------------------------------------------------------------
// @/ pseudo-ref resolution
// ---------------------------------------------------------------------------

/**
 * Walk a JSON value and replace any "@/relPath" strings with the real remote ID.
 * - Newly created records: remoteId comes from createIdMap.
 * - Existing records: remoteId is the filename stem (e.g. "recXXX.json" → "recXXX").
 */
function resolveAtRefs(value: unknown, createIdMap: Map<string, string>): unknown {
  if (typeof value === 'string' && value.startsWith('@/')) {
    const relPath = value.slice(2);
    if (createIdMap.has(relPath)) return createIdMap.get(relPath);
    const filename = relPath.split('/').pop() ?? '';
    return filename.replace(/\.json$/, '');
  }
  if (Array.isArray(value)) return value.map((v) => resolveAtRefs(v, createIdMap));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveAtRefs(v, createIdMap)]),
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Split "BaseA/TableB/rec.json" → ["BaseA/TableB", "rec.json"]. Root files → ["", "rec.json"]. */
function splitRelPath(relPath: string): [folder: string, filename: string] {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? ['', relPath] : [relPath.slice(0, idx), relPath.slice(idx + 1)];
}

function groupByFolder(relPaths: string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const rp of relPaths) {
    const [folder] = splitRelPath(rp);
    if (!map.has(folder)) map.set(folder, []);
    map.get(folder)!.push(rp);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Execution context threaded through phase execution
// ---------------------------------------------------------------------------

interface ExecCtx {
  repoPath: string;
  planId: string;
  plan: PlanMeta;
  connector: Connector<Service, JsonSafeObject>;
  schemaCache: Map<string, BaseJsonTableSpec | null>;
  /** relPath → remoteId: populated during create, consumed during backfill and rename */
  createIdMap: Map<string, string>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class PublishService {
  constructor(
    private readonly db: DbService,
    private readonly scratchGit: ScratchGitClient,
    private readonly connectors: ConnectorsService,
  ) {}

  async executePlan(connectionId: string, planId: string): Promise<void> {
    // 1. Look up connector account — API key must be in DB credentials (stored by setup command)
    const conn = await this.db.client.connectorAccount.findUniqueOrThrow({ where: { id: connectionId } });
    if (!conn.repoPath) throw new Error(`ConnectorAccount ${connectionId} has no repoPath`);

    const creds = (conn.credentials ?? {}) as Record<string, unknown>;
    const apiKey = creds['apiKey'] as string | undefined;
    if (!apiKey) throw new Error(`ConnectorAccount ${connectionId} has no apiKey in credentials — re-run setup`);

    const service = conn.service as Service;
    const connector = await this.connectors.getConnector({ service, connectorAccount: conn, apiKey });

    // 2. Read plan.json from dirty branch
    const planFiles = await this.scratchGit.readFiles(
      conn.repoPath,
      'dirty',
      `.scratch/publish-plans/${planId}`,
      ['plan.json'],
    );
    if (!planFiles.length) throw new Error(`Plan not found: .scratch/publish-plans/${planId}/plan.json`);

    const plan = JSON.parse(planFiles[0].content) as PlanMeta;
    WSLogger.info({
      source: 'Publish',
      message: `Executing plan ${planId} for ${plan.connectionName}`,
      summary: plan.summary,
    });

    // 3. Check for a prior partial run — skip already-completed phases
    const completedPhases = await this.readCompletedPhases(conn.repoPath, planId);
    if (completedPhases.length > 0) {
      WSLogger.info({ source: 'Publish', message: `Resuming — already completed: ${completedPhases.join(', ')}` });
    }

    const ctx: ExecCtx = {
      repoPath: conn.repoPath,
      planId,
      plan,
      connector,
      schemaCache: new Map(),
      createIdMap: new Map(),
    };

    // 4. Execute phases in order, skipping any already completed
    for (const phase of PHASE_ORDER) {
      if (completedPhases.includes(phase)) {
        WSLogger.info({ source: 'Publish', message: `Phase: ${phase} — already done, skipping` });
        continue;
      }

      const relPaths = plan.entries[phase] ?? [];
      if (!relPaths.length) {
        await this.markPhaseComplete(conn.repoPath, planId, phase, completedPhases);
        continue;
      }

      WSLogger.info({ source: 'Publish', message: `Phase: ${phase} (${relPaths.length} entries)` });
      await this.executePhase(phase, relPaths, ctx);
      await this.markPhaseComplete(conn.repoPath, planId, phase, completedPhases);
    }

    // 5. Rebase dirty to master
    const rebase = await this.scratchGit.rebaseDirty(conn.repoPath);
    WSLogger.info({ source: 'Publish', message: 'rebase-dirty complete', advanced: rebase.advanced });
  }

  // ---------------------------------------------------------------------------
  // Checkpointing: completed phases are written to master so they survive restart
  // ---------------------------------------------------------------------------

  private async readCompletedPhases(repoPath: string, planId: string): Promise<Phase[]> {
    const files = await this.scratchGit.readFiles(
      repoPath,
      'master',
      `.scratch/publish-plans/${planId}`,
      ['completed-phases.json'],
    );
    if (!files.length) return [];
    return JSON.parse(files[0].content) as Phase[];
  }

  private async markPhaseComplete(
    repoPath: string,
    planId: string,
    phase: Phase,
    completedSoFar: Phase[],
  ): Promise<void> {
    completedSoFar.push(phase);
    await this.scratchGit.upsertFiles({
      repoPath,
      folder: `.scratch/publish-plans/${planId}`,
      message: `publish: phase ${phase} complete`,
      files: [{ path: 'completed-phases.json', content: JSON.stringify(completedSoFar, null, 2) }],
    });
  }

  // ---------------------------------------------------------------------------
  // Phase execution
  // ---------------------------------------------------------------------------

  private async executePhase(phase: Phase, relPaths: string[], ctx: ExecCtx): Promise<void> {
    const byFolder = groupByFolder(relPaths);

    for (const [folder, folderRelPaths] of byFolder) {
      const tableSpec = await this.getTableSpec(ctx.repoPath, folder, ctx.schemaCache);
      if (!tableSpec) {
        WSLogger.warn({ source: 'Publish', message: `No schema.json for folder "${folder}", skipping` });
        continue;
      }

      const opType = phase === 'create' ? 'create' : phase === 'delete' ? 'delete' : 'update';
      const batchSize = ctx.connector.getBatchSize(opType);

      for (let i = 0; i < folderRelPaths.length; i += batchSize) {
        const batch = folderRelPaths.slice(i, i + batchSize);
        await this.executeBatch(phase, batch, folder, tableSpec, ctx);
      }
    }
  }

  private async executeBatch(
    phase: Phase,
    batch: string[],
    folder: string,
    tableSpec: BaseJsonTableSpec,
    ctx: ExecCtx,
  ): Promise<void> {
    const { repoPath, planId, plan, connector, createIdMap } = ctx;

    if (phase === 'delete') {
      const files = batch.map((relPath) => {
        const remoteId = plan.deleteIndex[relPath];
        if (!remoteId) throw new Error(`deleteIndex missing entry for ${relPath}`);
        return { [tableSpec.idColumnRemoteId]: remoteId } as ConnectorFile;
      });
      await connector.deleteRecords(tableSpec, files);

      // Remove deleted files from master so rebaseDirty doesn't reintroduce them
      await this.scratchGit.deleteFiles(
        repoPath,
        folder,
        `publish: delete ${folder}`,
        batch.map((rp) => splitRelPath(rp)[1]),
      );
      return;
    }

    if (phase === 'rename') {
      // New ID-named files were already upserted to master during the create phase.
      // Delete the pending files from master so they don't persist after rebaseDirty.
      const toDelete: string[] = [];
      for (const relPath of batch) {
        if (!createIdMap.has(relPath)) {
          WSLogger.warn({ source: 'Publish', message: `createIdMap missing for rename: ${relPath}` });
          continue;
        }
        toDelete.push(splitRelPath(relPath)[1]);
      }
      if (toDelete.length > 0) {
        await this.scratchGit.deleteFiles(repoPath, folder, `publish: rename pending → id in ${folder}`, toDelete);
      }
      return;
    }

    // edit / create / backfill: read file content from the plan in dirty branch
    const fileNames = batch.map((rp) => splitRelPath(rp)[1]);
    const planFolderPath = folder
      ? `.scratch/publish-plans/${planId}/${folder}/${phase}`
      : `.scratch/publish-plans/${planId}/${phase}`;

    const planFiles = await this.scratchGit.readFiles(repoPath, 'dirty', planFolderPath, fileNames);
    if (planFiles.length !== batch.length) {
      WSLogger.warn({
        source: 'Publish',
        message: `Expected ${batch.length} plan files for phase=${phase} folder=${folder}, got ${planFiles.length}`,
      });
    }

    const contents = planFiles.map((pf) => JSON.parse(pf.content) as Record<string, unknown>);

    if (phase === 'edit') {
      const changedKeys = batch.map((rp) => {
        const cf = plan.changedFields[rp];
        return cf ? Object.keys(cf) : undefined;
      });
      await connector.updateRecords(tableSpec, contents as ConnectorFile[], changedKeys);
    } else if (phase === 'create') {
      const created = await connector.createRecords(tableSpec, contents as ConnectorFile[]);

      const upsertFiles: Array<{ path: string; content: string }> = [];
      for (let j = 0; j < batch.length; j++) {
        const relPath = batch[j];
        const createdRecord = created[j] as Record<string, unknown>;
        const remoteId = createdRecord[tableSpec.idColumnRemoteId] as string;
        createIdMap.set(relPath, remoteId);

        const merged = { ...contents[j], [tableSpec.idColumnRemoteId]: remoteId };
        upsertFiles.push({ path: `${remoteId}.json`, content: JSON.stringify(merged, null, 2) });
      }

      await this.scratchGit.upsertFiles({
        repoPath,
        folder,
        message: `publish: create ${folder}`,
        files: upsertFiles,
      });
    } else if (phase === 'backfill') {
      const resolved = contents.map((c) => resolveAtRefs(c, createIdMap) as ConnectorFile);
      const changedKeys = batch.map((rp) => {
        const cf = plan.changedFields[rp];
        return cf ? Object.keys(cf) : undefined;
      });
      await connector.updateRecords(tableSpec, resolved, changedKeys);
    }
  }

  private async getTableSpec(
    repoPath: string,
    folder: string,
    cache: Map<string, BaseJsonTableSpec | null>,
  ): Promise<BaseJsonTableSpec | null> {
    if (cache.has(folder)) return cache.get(folder)!;
    const schemaFolderPath = folder ? `.scratch/${folder}` : '.scratch';
    const files = await this.scratchGit.readFiles(repoPath, 'master', schemaFolderPath, ['schema.json']);
    const spec = files.length ? (JSON.parse(files[0].content) as BaseJsonTableSpec) : null;
    cache.set(folder, spec);
    return spec;
  }
}
