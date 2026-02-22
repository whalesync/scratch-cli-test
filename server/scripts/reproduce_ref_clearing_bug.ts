/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { NestFactory } from '@nestjs/core';
import { AuthType, Service } from '@prisma/client';
import { WorkbookId } from '@spinner/shared-types';
import { randomUUID } from 'crypto';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db/db.service';
import { FileIndexService } from '../src/publish-pipeline/file-index.service';
import { FileReferenceService } from '../src/publish-pipeline/file-reference.service';
import { PublishPlanService } from '../src/publish-pipeline/publish-plan.service';
import { ScratchGitService } from '../src/scratch-git/scratch-git.service';

async function bootstrap() {
  try {
    const app = await NestFactory.createApplicationContext(AppModule);
    const dbService = app.get(DbService);
    const planService = app.get(PublishPlanService);
    const gitService = app.get(ScratchGitService);
    const fileIndexService = app.get(FileIndexService);
    const fileRefService = app.get(FileReferenceService);

    console.log('Context created. Setting up test env...');

    const org = await dbService.client.organization.findFirst();
    if (!org) throw new Error('No org found');

    const userId = 'user_repro_ref_fix';
    // Ensure user exists
    await dbService.client.user.upsert({
      where: { id: userId },
      update: {},
      create: {
        id: userId,
        clerkId: `clerk_${randomUUID()}`,
        email: 'test@example.com',
        organizationId: org.id,
      },
    });

    // Workbook (Create FIRST so ConnectorAccount can link to it)
    const workbookId = `wkb_${randomUUID()}` as WorkbookId;
    await dbService.client.workbook.create({
      data: {
        id: workbookId,
        organizationId: org.id,
        userId: userId,
        name: 'Ref Clearing Repro',
      },
    });
    console.log(`Workbook: ${workbookId}`);

    // Connector Account
    const connectorAccountId = `ca_${randomUUID()}`;
    await dbService.client.connectorAccount.create({
      data: {
        id: connectorAccountId,
        workbookId,
        displayName: 'Test Connector',
        service: Service.NOTION,
        authType: AuthType.OAUTH,
      },
    });

    // Init Git
    await gitService.initRepo(workbookId);

    // --- Step 1: Initial State (Main) ---
    const tag1Id = 'tag_1';
    const tag2Id = 'tag_2';
    const author1Id = 'author_1';

    const tagSchema = {
      type: 'object',
      properties: {
        id: { type: 'string' },
        name: { type: 'string' },
      },
      primaryKey: 'id',
    };

    // Create DataFolders
    const dfTags = await dbService.client.dataFolder.create({
      data: {
        id: `df_tags_${randomUUID()}`,
        workbookId,
        connectorAccountId,
        name: 'Tags',
        path: '/tags', // Leading slash
        lastSchemaRefreshAt: new Date(),
        schema: tagSchema,
      },
    });

    const authorSchema = {
      id: { wsId: '...' },
      name: 'Authors',
      slug: 'authors',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          fieldData: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              tags: {
                type: 'array',
                items: {
                  type: 'string',
                },
                'x-scratch-foreign-key': {
                  linkedTableId: dfTags.id,
                },
              },
            },
          },
        },
        primaryKey: 'id',
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const dfAuthors = await dbService.client.dataFolder.create({
      data: {
        id: `df_authors_${randomUUID()}`,
        workbookId,
        connectorAccountId,
        name: 'Authors',
        path: '/authors', // Leading slash
        lastSchemaRefreshAt: new Date(),
        schema: authorSchema, // Store the WHOLE wrapped object as the DataFolder schema
      },
    });

    // Commit schemas first
    await gitService.commitFilesToBranch(
      workbookId,
      'main',
      [
        { path: 'tags/schema.json', content: JSON.stringify(tagSchema) },
        // Schema is in DB, but we populate git for completeness/legacy check
        { path: 'authors/schema.json', content: JSON.stringify(authorSchema.schema) },
      ],
      'Add schemas',
    );

    // Commit Data
    await gitService.commitFilesToBranch(
      workbookId,
      'main',
      [
        { path: 'tags/tag1.json', content: JSON.stringify({ id: tag1Id, name: 'Tag 1' }) },
        { path: 'tags/tag2.json', content: JSON.stringify({ id: tag2Id, name: 'Tag 2' }) },
        {
          path: 'authors/author1.json',
          content: JSON.stringify({
            id: author1Id,
            fieldData: {
              name: 'Author 1',
              tags: [tag1Id, tag2Id],
            },
          }),
        },
      ],
      'Initial commit',
    );

    // Build Index so we know about record IDs
    console.log('Building File Index...');
    await fileIndexService.upsertBatch([
      { workbookId, folderPath: 'tags', filename: 'tag1.json', recordId: tag1Id },
      { workbookId, folderPath: 'tags', filename: 'tag2.json', recordId: tag2Id },
      { workbookId, folderPath: 'authors', filename: 'author1.json', recordId: author1Id },
    ]);

    // Populate FileReference Table (MISSING PIECE)
    console.log('Populating File References...');
    await fileRefService.updateRefsForFiles(
      workbookId,
      'main',
      [
        {
          path: 'authors/author1.json',
          content: {
            id: author1Id,
            fieldData: {
              name: 'Author 1',
              tags: [tag1Id, tag2Id],
            },
          },
        },
      ],
      authorSchema,
    );

    // --- Step 2: Simulate Deletion (Dirty) ---
    // Reset dirty to match main first
    await gitService.discardChanges(workbookId);

    // Now delete tag1.json in dirty
    try {
      await gitService.deleteFile(workbookId, ['tags/tag1.json'], 'Delete tag1');
    } catch (e) {
      console.log('Error deleting file:', e);
    }

    // --- Step 3: Run Pipeline Build ---
    console.log('Building Pipeline...');
    const pipeline = await planService.buildPipeline(workbookId, userId, connectorAccountId);

    console.log(`Pipeline ID: ${pipeline.pipelineId}`);

    // --- Step 4: Verify Entries ---
    const entries = await dbService.client.publishPlanEntry.findMany({
      where: { planId: pipeline.pipelineId },
    });

    console.log(`Entries found: ${entries.length}`);
    entries.forEach((e) => {
      console.log(`- ${e.filePath} [${e.phase.toUpperCase()}]`);
      if (e.phase === 'edit' && e.operation) {
        const json = e.operation as any;
        console.log('  Content:', JSON.stringify(json));
      }
    });

    if (entries.length === 2) {
      console.log('SUCCESS: Ref clearing working as expected.');
    } else {
      console.log('FAILURE: Incorrect number of entries.');
    }

    // Cleanup
    await gitService.deleteRepo(workbookId);
    await dbService.client.workbook.delete({ where: { id: workbookId } });
    await app.close();
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

void bootstrap();
