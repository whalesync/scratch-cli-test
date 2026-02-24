/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { NestFactory } from '@nestjs/core';
import { WorkbookId } from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import 'dotenv/config';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db/db.service';
import { PublishPlanBuildService } from '../src/publish-plan/publish-plan-build.service';
import { PublishPlanRunService } from '../src/publish-plan/publish-plan-run.service';
import { ScratchGitService } from '../src/scratch-git/scratch-git.service';

async function bootstrap() {
  try {
    console.log('Bootstrapping...');
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error', 'warn'],
    });
    const planService = app.get(PublishPlanBuildService);
    const runService = app.get(PublishPlanRunService);
    const gitService = app.get(ScratchGitService);
    const dbService = app.get(DbService);

    console.log('Context created. Getting user...');

    // 1. Get/Create User
    let user = await dbService.client.user.findFirst();
    if (!user) {
      user = await dbService.client.user.create({
        data: {
          id: `user_${randomUUID()}`,
          email: `test-${randomUUID()}@test.com`,
          name: 'Test User',
        },
      });
    }
    console.log(`User: ${user.id}`);

    // 1.5 Get/Create Organization
    let org = await dbService.client.organization.findFirst();
    if (!org) {
      org = await dbService.client.organization.create({
        data: {
          id: 'org_' + randomUUID(),
          clerkId: 'org_clerk_' + randomUUID(),
          name: 'Test Org',
        },
      });
    }

    // 2. Create Workbook
    const workbook = await dbService.client.workbook.create({
      data: {
        id: `wkb_${randomUUID()}`,
        name: `Test V2 ${Date.now()}`,
        organizationId: org.id,
        userId: user.id,
      },
    });
    console.log(`Workbook: ${workbook.id}`);
    const wkbId = workbook.id as WorkbookId;

    // 3. Init Repo
    await gitService.initRepo(wkbId);

    // 3.5 Create DataFolder for schema resolution
    // We reuse schemaContent defined below or define it once here.
    const schemaContentForDf = {
      type: 'object',
      properties: {
        ref: { type: 'string', 'x-scratch-foreign-key': 'folder' },
      },
    };

    const dataFolder = await dbService.client.dataFolder.create({
      data: {
        id: `df_${randomUUID()}`,
        workbookId: wkbId,
        path: '/folder',
        name: 'folder',
        lastSchemaRefreshAt: new Date(),
        // index: 0, // Removed as it doesn't exist in schema
        schema: {
          id: 'rt_folder',
          slug: 'folder',
          name: 'folder',
          schema: schemaContentForDf,
          idColumnRemoteId: 'id',
        } as any,
      },
    });
    const dfId = dataFolder.id;

    // 4. Create a file (will be added to dirty)
    // We create a dummy schema first so our stripping logic has something to read
    const schemaPath = 'folder/schema.json';
    // schemaContent variable downstream will be shadowed or conflict if I used let.
    // The previous code had const schemaContent.
    // I will just use schemaContentForDf here too.

    const existingPath = 'folder/existing.json';
    const existingContentMain = { name: 'Existing File' };

    await gitService.commitFilesToBranch(
      wkbId,
      'main',
      [
        { path: schemaPath, content: JSON.stringify(schemaContentForDf) },
        { path: existingPath, content: JSON.stringify(existingContentMain) },
      ],
      'Add existing files to main',
    );

    // 2. Setup "Dirty" state (Simulate user edits)
    // - Add new file
    const newPath = 'folder/new.json';
    const newContent = { name: 'New File' };
    // - Modify existing file to point to new file
    const existingContentDirty = {
      name: 'Existing File Modified',
      ref: '@/folder/new.json', // Ref to new file
    };

    // Commit both to dirty
    // Note: We include schema again or assume it's there?
    // If we branched dirty off main initially, it would be there.
    // But since we committed to main independently, dirty might not have schema if we didn't commit it there.
    // So let's commit schema to dirty too to be safe.
    await gitService.commitFilesToBranch(
      wkbId,
      'dirty',
      [
        { path: schemaPath, content: JSON.stringify(schemaContentForDf) },
        { path: newPath, content: JSON.stringify(newContent) },
        { path: existingPath, content: JSON.stringify(existingContentDirty) },
      ],
      'User edits',
    );
    console.log('Committed files to main and dirty');

    // 5. Build Pipeline
    console.log('Building pipeline...');
    const plan = await planService.buildPipeline(workbook.id, user.id);
    console.log(`Built Pipeline: ${plan.pipelineId}`);
    // console.log(`Phases:`, JSON.stringify(plan.phases, null, 2));

    // 6. Verify Entries
    const entries = await dbService.client.publishPlanOperation.findMany({
      where: { planId: plan.pipelineId },
    });
    console.log(`Entries found: ${entries.length}`);

    // Check existing file for Edit + Backfill
    // existingPath is already defined above
    const editEntry = entries.find((e) => e.filePath === existingPath && e.phase === 'edit');
    if (editEntry) {
      console.log('Found edit entry:', editEntry.filePath);

      // Check Edit Operation (Should be stripped)
      if (editEntry.content) {
        const json = editEntry.content as any;
        if (editEntry.dataFolderId !== dfId) {
          console.error(`FAILURE: dataFolderId mismatch. Expected ${dfId}, got ${editEntry.dataFolderId}`);
        } else {
          console.log(`SUCCESS: Edit Entry dataFolderId matches: ${editEntry.dataFolderId}`);
        }
        if (json.ref === null || json.ref === undefined) {
          console.log('SUCCESS: Edit Ref was stripped!');
        } else {
          console.error('FAILURE: Edit Ref was NOT stripped:', json.ref);
        }
      } else {
        console.error('FAILURE: No edit operation found');
      }
    } else {
      console.error('FAILURE: Edit entry not found for path ' + existingPath);
    }

    const backfillEntry = entries.find((e) => e.filePath === existingPath && e.phase === 'backfill');
    if (backfillEntry) {
      // Check Backfill Operation (Should exist and have ref)
      if (backfillEntry.content) {
        const json = backfillEntry.content as any;
        if (json.ref === '@/folder/new.json') {
          console.log('SUCCESS: Backfill has Ref!');
        } else {
          console.error('FAILURE: Backfill Ref incorrect:', json.ref);
        }
      } else {
        console.error('FAILURE: No backfill operation found');
      }
    } else {
      console.error('FAILURE: Backfill entry not found for path ' + existingPath);
    }

    // Cleanup
    console.log('Cleaning up...');
    await gitService.deleteRepo(wkbId);
    await dbService.client.workbook.delete({ where: { id: workbook.id } });

    await app.close();
  } catch (error) {
    console.error('Bootstrap Failed:', error);
    process.exit(1);
  }
}

bootstrap();
