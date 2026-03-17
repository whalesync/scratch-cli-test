/**
 * Standalone bootstrap for CLI commands (setup, trigger-pull, poll, publish).
 * Uses a minimal module — no HTTP server, no BullMQ worker starting up.
 */
import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { DbModule } from './db/db.module';
import { ScratchGitModule } from './scratch-git/scratch-git.module';
import { WorkbookModule } from './workbook/workbook.module';
import { JobModule } from './job/job.module';
import { WorkerEnqueuerModule } from './worker-enqueuer/worker-enqueuer.module';
import { PollModule } from './poll/poll.module';
import { ConnectorsModule } from './remote-service/connectors/connectors.module';
import { WorkbookService } from './workbook/workbook.service';
import { ScratchGitClient } from './scratch-git/scratch-git.client';
import { BullEnqueuerService } from './worker-enqueuer/bull-enqueuer.service';
import { PollJob } from './poll/poll.job';
import { ConnectorsService } from './remote-service/connectors/connectors.service';
import { Service } from './types/shared-types';
import { WSLogger } from './logger';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    DbModule,
    WorkbookModule,
    ScratchGitModule,
    JobModule,
    WorkerEnqueuerModule,
    PollModule,
    ConnectorsModule,
  ],
})
class CliModule {}

async function runSetup(app: any): Promise<void> {
  const workbookService = app.get(WorkbookService);
  const scratchGit = app.get(ScratchGitClient);

  console.log('\n=== Experiment Setup ===\n');
  console.log('Wiping old workbook data from DB...');
  await workbookService.deleteExperiment();
  console.log('Creating org, workbook, and connections in DB...');
  await workbookService.upsertExperiment();

  const workbookId = (app.get(ConfigService) as ConfigService).getOrThrow('EXP_WORKBOOK_ID');
  const workbook = await workbookService.findById(workbookId);
  if (!workbook) throw new Error('Workbook not found after upsert');

  console.log('\nInitializing git repos via scratchmd...');
  await scratchGit.initRepo(workbook.workbookRepoPath);
  console.log(`  ✓ workbook: ${workbook.workbookRepoPath}`);
  for (const conn of workbook.connectorAccounts) {
    await scratchGit.initRepo(conn.repoPath);
    console.log(`  ✓ ${conn.name}: ${conn.repoPath}`);
  }

  console.log('\n✓ Setup complete. Next: yarn trigger-pull');
}

async function runPoll(app: any): Promise<void> {
  const pollJob = app.get(PollJob);
  const workbookService = app.get(WorkbookService);
  const config = app.get(ConfigService);

  const workbookId = config.getOrThrow('EXP_WORKBOOK_ID');
  const workbook = await workbookService.findById(workbookId);
  if (!workbook) throw new Error(`Workbook ${workbookId} not found — run yarn setup first`);

  console.log('\n=== Poll (inline, no BullMQ) ===\n');

  for (const conn of workbook.connectorAccounts) {
    console.log(`Polling: ${conn.name} (${conn.id})`);
    const result = await pollJob.run({
      data: { workbookId, connectorAccountId: conn.id, userId: 'system' },
      checkpoint: async () => {},
    });
    console.log(`✓ Done: ${result.result} files in ${result.executionTime}ms`);
  }
}

async function runTriggerPull(app: any): Promise<void> {
  const enqueuer = app.get(BullEnqueuerService);
  const workbookService = app.get(WorkbookService);
  const config = app.get(ConfigService);

  const workbookId = config.getOrThrow('EXP_WORKBOOK_ID');

  const workbook = await workbookService.findById(workbookId);
  if (!workbook) throw new Error(`Workbook ${workbookId} not found — run yarn setup first`);

  console.log('\n=== Trigger Pull ===\n');

  for (const conn of workbook.connectorAccounts) {
    const job = await enqueuer.enqueuePollJob({ workbookId, connectorAccountId: conn.id, userId: 'system' });
    console.log(`✓ Poll job enqueued for: ${conn.name} (${conn.id}) → job ${job.id}`);
  }

  console.log('\n  Watch the dev server terminal for progress.');
}

/**
 * Publish command: diff dirty vs master in each connector's bare repo,
 * then call connector create/update for each changed file.
 *
 * Filter: only files that differ between dirty and master (by blob OID).
 * After publishing a created record, write the returned remote ID back
 * into dirty via upsertFiles so the next publish sees it as an update.
 */
async function runPublish(app: any): Promise<void> {
  const workbookService = app.get(WorkbookService);
  const scratchGit = app.get(ScratchGitClient);
  const connectorsService = app.get(ConnectorsService);
  const config = app.get(ConfigService) as ConfigService;

  const workbookId = config.getOrThrow('EXP_WORKBOOK_ID');
  const workbook = await workbookService.findById(workbookId);
  if (!workbook) throw new Error(`Workbook ${workbookId} not found — run yarn setup first`);

  console.log('\n=== Publish ===\n');

  for (const conn of workbook.connectorAccounts) {
    console.log(`Publishing: ${conn.name} (${conn.id})`);

    // Diff dirty vs master — only files that differ get published
    const diffResult = await scratchGit.diff(conn.repoPath, 'master', 'dirty');
    const changedFiles = diffResult.files.filter((f: { status: string }) => f.status !== 'deleted');

    if (changedFiles.length === 0) {
      console.log(`  no changes between master and dirty`);
      continue;
    }
    console.log(`  ${changedFiles.length} changed file(s) to publish`);

    const service = conn.service as Service;
    const apiKey = service === Service.AIRTABLE
      ? config.getOrThrow('AIRTABLE_API_KEY')
      : config.getOrThrow('WEBFLOW_API_KEY');

    const connector = await connectorsService.getConnector({ service, connectorAccount: conn, apiKey });

    // Group changed files by their folder (= table path, e.g. "SiteName/Posts")
    const byFolder = new Map<string, string[]>();
    for (const entry of changedFiles) {
      // path looks like "SiteName/Posts/recXXX.json"
      const parts = entry.path.split('/');
      const folder = parts.slice(0, -1).join('/');
      if (!byFolder.has(folder)) byFolder.set(folder, []);
      byFolder.get(folder)!.push(entry.path);
    }

    for (const [folder, filePaths] of byFolder) {
      // Derive a minimal TableId to get the table spec
      // We store the schema at .scratch/{folder}/schema.json
      // fetchJsonTableSpec needs an EntityId — but we don't have it easily here.
      // Instead: list all tables from the connector and find the one matching this folder.
      const allTables = await connector.listTables();
      const tableSpec = await (async () => {
        for (const table of allTables) {
          try {
            const spec = await connector.fetchJsonTableSpec(table.id);
            const specFolder = [...(spec.basePath ?? []), spec.name].join('/');
            if (specFolder === folder) return spec;
          } catch {
            // skip tables that fail to load
          }
        }
        return null;
      })();

      if (!tableSpec) {
        WSLogger.warn({ source: 'Publish', message: `No table spec found for folder "${folder}", skipping` });
        continue;
      }

      const toCreate: Array<{ filePath: string; record: Record<string, unknown> }> = [];
      const toUpdate: Array<{ filePath: string; record: Record<string, unknown> }> = [];

      const fileNames = filePaths.map((p) => p.split('/').pop()!);
      const readResults = await scratchGit.readFiles(conn.repoPath, 'dirty', folder, fileNames);
      for (const { path: filePath, content } of readResults) {
        const record = JSON.parse(content) as Record<string, unknown>;
        if (record['id']) {
          toUpdate.push({ filePath, record });
        } else {
          toCreate.push({ filePath, record });
        }
      }

      // Create new records
      if (toCreate.length > 0) {
        console.log(`  ${folder}: creating ${toCreate.length} record(s)`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const created = await connector.createRecords(tableSpec, toCreate.map((r) => r.record) as any);
        // Write returned IDs back into dirty branch
        const idWrites = (created as Array<Record<string, unknown>>)
          .map((createdRecord, i) => {
            const origFilePath = toCreate[i].filePath;
            const filename = origFilePath.split('/').pop()!;
            const mergedContent = JSON.stringify({ ...toCreate[i].record, id: createdRecord['id'] }, null, 2);
            return { path: filename, content: mergedContent };
          });
        if (idWrites.length > 0) {
          const folder = toCreate[0].filePath.split('/').slice(0, -1).join('/');
          await scratchGit.upsertFiles({ repoPath: conn.repoPath, folder, message: 'publish: write remote IDs', files: idWrites });
        }
      }

      // Update existing records
      if (toUpdate.length > 0) {
        console.log(`  ${folder}: updating ${toUpdate.length} record(s)`);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await connector.updateRecords(tableSpec, toUpdate.map((r) => r.record) as any);
      }
    }

    // Rebase dirty to master so dirty catches up after the ID writes
    const rebase = await scratchGit.rebaseDirty(conn.repoPath);
    WSLogger.info({ source: 'Publish', message: 'rebase-dirty complete', connector: conn.name, advanced: rebase.advanced });
    console.log(`  ✓ ${conn.name} published`);
  }

  console.log('\nPublish complete.');
}

async function main() {
  const command = process.argv[2];
  const validCommands = ['setup', 'trigger-pull', 'poll', 'publish'];
  if (!command || !validCommands.includes(command)) {
    console.error(`Usage: ts-node bootstrap-command.ts <${validCommands.join('|')}>`);
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(CliModule, { logger: ['error', 'warn', 'log'] });

  try {
    if (command === 'setup') await runSetup(app);
    else if (command === 'trigger-pull') await runTriggerPull(app);
    else if (command === 'poll') await runPoll(app);
    else if (command === 'publish') await runPublish(app);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
