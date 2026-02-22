import { NestFactory } from '@nestjs/core';
import { WorkbookId } from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db/db.service';
import { PublishPlanService } from '../src/publish-pipeline/publish-plan.service';
import { ScratchGitService } from '../src/scratch-git/scratch-git.service';

async function bootstrap() {
  try {
    const app = await NestFactory.createApplicationContext(AppModule);
    const dbService = app.get(DbService);
    const planService = app.get(PublishPlanService);
    const gitService = app.get(ScratchGitService);

    console.log('Context created. Getting user...');
    // Try to find a user or create one if needed, but assuming existing dev setup
    const user = await dbService.client.user.findFirst();
    if (!user) throw new Error('No user found - please run locally with seed data');
    console.log(`User: ${user.id}`);

    const org = await dbService.client.organization.findFirst();
    if (!org) throw new Error('No org found');

    // Create Workbook
    const workbook = await dbService.client.workbook.create({
      data: {
        id: `wkb_${randomUUID()}`,
        organizationId: org.id,
        userId: user.id,
        name: 'Scope Test Workbook',
      },
    });
    const wkbId = workbook.id as WorkbookId;
    console.log(`Workbook: ${wkbId}`);

    // Init Git
    await gitService.initRepo(wkbId);

    // Create DataFolder
    // We manually specify ID if needed, or let Prisma gen uuid
    const dataFolder = await dbService.client.dataFolder.create({
      data: {
        id: `df_${randomUUID()}`,
        workbookId: workbook.id,
        name: 'Folder A',
        path: 'folder_a',
        lastSchemaRefreshAt: new Date(),
      },
    });
    console.log(`DataFolder created: ${dataFolder.id} (path: ${dataFolder.path})`);

    // Commit Files to DIRTY (Added files)
    const fileA = 'folder_a/file1.json';
    const fileB = 'folder_b/file2.json';

    await gitService.commitFilesToBranch(
      wkbId,
      'dirty',
      [
        { path: fileA, content: JSON.stringify({ name: 'File A' }) },
        { path: fileB, content: JSON.stringify({ name: 'File B' }) },
      ],
      'Add files',
    );
    console.log('Committed files to dirty');

    // Build Pipeline Scoped to DataFolder
    // We expect only fileA to be in the pipeline
    console.log('Building pipeline scoped to Folder A...');
    const plan = await planService.buildPipeline(workbook.id, user.id, dataFolder.id);
    console.log(`Built Pipeline: ${plan.pipelineId}`);

    // Verify Entries
    const entries = await dbService.client.publishPlanEntry.findMany({
      where: { planId: plan.pipelineId },
    });
    console.log(`Entries found: ${entries.length}`);

    let success = false;
    if (entries.length === 1 && entries[0].filePath === fileA) {
      console.log('SUCCESS: Pipeline correctly scoped to Folder A');
      success = true;
    } else {
      console.error('FAILURE: Pipeline has incorrect entries');
      entries.forEach((e) => console.log(`- ${e.filePath}`));
    }

    // Cleanup
    console.log('Cleaning up...');
    await gitService.deleteRepo(wkbId);
    await dbService.client.workbook.delete({ where: { id: workbook.id } });
    await app.close();

    if (!success) process.exit(1);
  } catch (error) {
    console.error('Bootstrap Failed:', error);
    process.exit(1);
  }
}

void bootstrap();
