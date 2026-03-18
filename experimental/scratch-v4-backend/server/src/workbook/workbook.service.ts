import { Injectable } from '@nestjs/common';
import * as path from 'path';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';

export interface ConnectorAccountRow {
  id: string;
  name: string;
  repoPath: string;
}

export interface WorkbookRow {
  id: string;
  name: string;
  orgId: string;
  workbookRepoPath: string;
  connectorAccounts: ConnectorAccountRow[];
}

@Injectable()
export class WorkbookService {
  constructor(
    private readonly db: DbService,
    private readonly config: ScratchConfigService,
  ) {}

  async findById(workbookId: string): Promise<WorkbookRow | null> {
    const workbook = await this.db.client.workbook.findUnique({
      where: { id: workbookId },
      include: { connectorAccounts: true },
    });

    if (!workbook) return null;

    return {
      id: workbook.id,
      name: workbook.name,
      orgId: workbook.organizationId,
      workbookRepoPath: this.buildWorkbookRepoPath(workbook.organizationId, workbook.id),
      connectorAccounts: workbook.connectorAccounts.map((c) => ({
        id: c.id,
        name: c.displayName,
        repoPath: c.repoPath ?? this.buildRepoPath(workbook.organizationId, workbookId, c.id),
      })),
    };
  }

  async deleteExperiment(): Promise<void> {
    const workbookId = this.config.getOrThrow('EXP_WORKBOOK_ID');
    // Delete jobs first (no cascade from workbook)
    await this.db.client.job.deleteMany({ where: { workbookId } });
    // Delete connector accounts, then workbook
    await this.db.client.connectorAccount.deleteMany({ where: { workbookId } });
    await this.db.client.workbook.deleteMany({ where: { id: workbookId } });
  }

  async upsertExperiment(): Promise<{ repoPath: string }> {
    const orgId = this.config.getOrThrow('EXP_ORG_ID');
    const workbookId = this.config.getOrThrow('EXP_WORKBOOK_ID');
    const connId = this.config.getOrThrow('EXP_CONN_ID');

    await this.db.client.organization.upsert({
      where: { id: orgId },
      create: { id: orgId, name: 'Experiment Org' },
      update: {},
    });

    await this.db.client.workbook.upsert({
      where: { id: workbookId },
      create: { id: workbookId, name: 'My Project', organizationId: orgId },
      update: {},
    });

    const repoPath = this.buildRepoPath(orgId, workbookId, connId);

    const airtableApiKey = this.config.getAirtableApiKey();
    await this.db.client.connectorAccount.upsert({
      where: { id: connId },
      create: { id: connId, workbookId, service: 'AIRTABLE', displayName: 'Airtable', repoPath, credentials: { apiKey: airtableApiKey } },
      update: { repoPath, credentials: { apiKey: airtableApiKey } },
    });

    const webflowConnId = this.config.getOrThrow('EXP_WEBFLOW_CONN_ID');
    const webflowRepoPath = this.buildRepoPath(orgId, workbookId, webflowConnId);
    const webflowApiKey = this.config.getWebflowApiKey();

    await this.db.client.connectorAccount.upsert({
      where: { id: webflowConnId },
      create: { id: webflowConnId, workbookId, service: 'WEBFLOW', displayName: 'Webflow', repoPath: webflowRepoPath, credentials: { apiKey: webflowApiKey } },
      update: { repoPath: webflowRepoPath, credentials: { apiKey: webflowApiKey } },
    });

    console.debug(`  org:               ${orgId}`);
    console.debug(`  workbook:          ${workbookId}`);
    console.debug(`  airtable conn:     ${connId} → ${repoPath}`);
    console.debug(`  webflow conn:      ${webflowConnId} → ${webflowRepoPath}`);

    return { repoPath };
  }

  buildRepoPath(orgId: string, workbookId: string, connId: string): string {
    const reposDir = this.config.getGitReposDir();
    return path.join(reposDir, orgId, workbookId, connId, 'repo.git');
  }

  buildWorkbookRepoPath(orgId: string, workbookId: string): string {
    const reposDir = this.config.getGitReposDir();
    return path.join(reposDir, orgId, workbookId, 'workbook.git');
  }
}
