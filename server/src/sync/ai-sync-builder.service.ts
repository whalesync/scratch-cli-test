import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import {
  AiGenerateSyncResponse,
  AiGenerateSyncTablePairing,
  AiPromptHistoryEntry,
  SaveSyncBody,
  SyncId,
  SyncMapping,
  WorkbookId,
} from '@spinner/shared-types';
import { ScratchConfigService } from 'src/config/scratch-config.service';
import { DbService } from 'src/db/db.service';
import { WSLogger } from 'src/logger';
import { syncMappingSchema } from 'src/sync/sync-mapping.schema';
import { Actor } from 'src/users/types';
import { z } from 'zod';
import { SyncService } from './sync.service';

const aiSyncResponseSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .describe(
      'A concise, descriptive name for this sync in title case. Prefer ≤35 chars when a clear name fits; max 60.',
    ),
  mapping: syncMappingSchema
    .nullable()
    .describe(
      'The SyncMapping object as defined in the schema. Return null if no mapping is needed (e.g. asking for clarification).',
    ),
  summary: z
    .string()
    .describe('A 1-2 sentence description of the result or request for clarification to show to the user.'),
  result: z
    .enum(['success', 'message'])
    .describe(
      'Return "success" if the agent did work/changed mappings, or "message" to respond to a question or ask for clarification without changing mappings.',
    ),
});

type AiSyncResponse = z.infer<typeof aiSyncResponseSchema>;

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

@Injectable()
export class AiSyncBuilderService {
  constructor(
    private readonly syncService: SyncService,
    private readonly db: DbService,
    private readonly scratchConfigService: ScratchConfigService,
  ) {}

  /**
   * Appends output instructions for our internal LLM call: respond with {name, mapping} envelope.
   */
  async generateInternalAgentContext(workbookId: WorkbookId, actor: Actor): Promise<string> {
    const { markdown } = await this.syncService.generateAiContext(workbookId, actor);
    const lines: string[] = [markdown, '## Output', ''];
    lines.push('Respond with ONLY a JSON object in this exact envelope — no prose, no markdown outside the code:');
    lines.push('');
    lines.push('```json');
    lines.push('{');
    lines.push('  "name": "<a concise, descriptive name for this sync>",');
    lines.push('  "mapping": null | { <the SyncMapping object> },');
    lines.push('  "summary": "<1-2 sentences describing the result, changes made, or clarification requested>",');
    lines.push('  "result": "success" | "message"');
    lines.push('}');
    lines.push('```');
    lines.push('');
    lines.push('Rules for `name`:');
    lines.push('- If a clear, meaningful name fits within 35 characters, use it (preferred).');
    lines.push('- Otherwise use up to 60 characters. Never exceed 60.');
    lines.push('- Use title case. No trailing punctuation.');
    lines.push('');
    return lines.join('\n');
  }

  /**
   * Appends output instructions for external agents: respond with only the raw SyncMapping JSON.
   */
  async generateExternalAgentContext(workbookId: WorkbookId, actor: Actor): Promise<string> {
    const { markdown } = await this.syncService.generateAiContext(workbookId, actor);
    const lines: string[] = [markdown, '## Output', ''];
    lines.push('Respond with ONLY the raw `SyncMapping` JSON object — no envelope, no prose, no markdown fences.');
    lines.push('The response must be valid JSON that can be parsed directly as a SyncMapping.');
    lines.push('');
    return lines.join('\n');
  }

  private buildStructuredLlm(apiKey: string, modelName: string): ReturnType<ChatOpenAI['withStructuredOutput']> {
    const isJsonSchema = modelName.startsWith('google/');
    const llm = new ChatOpenAI({
      apiKey,
      modelName,
      configuration: { baseURL: 'https://openrouter.ai/api/v1' },
    });
    return llm.withStructuredOutput(aiSyncResponseSchema, {
      name: 'ai_sync_response',
      method: isJsonSchema ? 'jsonSchema' : 'jsonMode',
    });
  }

  private async invokeLlm(
    structuredLlm: ReturnType<ChatOpenAI['withStructuredOutput']>,
    systemPrompt: string,
    userMessage: string,
    workbookId: WorkbookId,
  ): Promise<{ response: AiSyncResponse; history: string }> {
    const messages = [new SystemMessage(systemPrompt), new HumanMessage(userMessage)];
    try {
      const response = (await structuredLlm.invoke(messages, {
        metadata: { workbookId, feature: 'ai-sync-builder' },
        tags: ['ai-sync-builder'],
        runName: 'ai-sync-builder',
      })) as AiSyncResponse;

      const historyObj = { parsedResponse: response };
      return { response, history: JSON.stringify(historyObj, null, 2) };
    } catch (err) {
      const errorResponse = {
        error: toErrorMessage(err),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        providerError: (err as any).error,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        responseData: (err as any).response?.data,
      };

      WSLogger.error({
        source: 'AiSyncBuilderService',
        message: 'LLM call failed',
        error: err,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        providerError: (err as any).error,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        responseData: (err as any).response?.data,
      });
      throw new BadRequestException(
        "The AI couldn't generate a valid sync from that description. Try being more specific about which tables and fields to sync.\n\n" +
          'Diagnostics:\n' +
          JSON.stringify(errorResponse, null, 2),
      );
    }
  }

  private appendPromptHistory(systemPrompt: string, history: AiPromptHistoryEntry[]): string {
    if (!history.length) return systemPrompt;
    const lines: string[] = [systemPrompt, '## Previous Prompts', ''];
    lines.push(
      'The user has already prompted for this sync. Use this history to understand context and apply corrections:',
    );
    lines.push('');
    for (const [i, entry] of history.entries()) {
      lines.push(`### Prompt ${i + 1}`);
      lines.push(`**User:** ${entry.prompt}`);
      if (entry.error) {
        lines.push(`**Result:** Failed — ${entry.error}`);
      } else {
        lines.push('**Result:** Applied successfully.');
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  private buildTablePairings(
    tableMappings: SyncMapping['tableMappings'],
    folderMap: Map<string, { name: string; connectorService: string | null }>,
  ): AiGenerateSyncTablePairing[] {
    return tableMappings.map((tm) => {
      const src = folderMap.get(tm.sourceDataFolderId);
      const dest = folderMap.get(tm.destinationDataFolderId);
      return {
        sourceFolderId: tm.sourceDataFolderId,
        sourceFolderName: src?.name ?? tm.sourceDataFolderId,
        sourceConnectorService: src?.connectorService ?? null,
        destFolderId: tm.destinationDataFolderId,
        destFolderName: dest?.name ?? tm.destinationDataFolderId,
        destConnectorService: dest?.connectorService ?? null,
      };
    });
  }

  private async loadFolderMap(
    workbookId: WorkbookId,
  ): Promise<Map<string, { name: string; connectorService: string | null }>> {
    const dataFolders = await this.db.client.dataFolder.findMany({
      where: { workbookId },
      include: { connectorAccount: true },
    });
    return new Map(dataFolders.map((f) => [f.id, { name: f.name, connectorService: f.connectorService }]));
  }

  async generateSyncFromPrompt(
    workbookId: WorkbookId,
    prompt: string,
    actor: Actor,
    model?: string,
  ): Promise<AiGenerateSyncResponse> {
    const apiKey = this.scratchConfigService.getOpenRouterApiKeyOptional();
    if (!apiKey) {
      throw new ServiceUnavailableException('AI sync generation is not configured. Contact your administrator.');
    }

    const systemPrompt = await this.generateInternalAgentContext(workbookId, actor);
    const userMessage = `User request: "${prompt}"\n\nGenerate a sync mapping and a concise name for it.`;

    WSLogger.info({
      source: 'AiSyncBuilderService.generateSyncFromPrompt',
      message: 'Calling LLM via OpenRouter',
      workbookId,
      model,
    });

    const targetModel = model || 'google/gemini-3.1-pro-preview';
    const structuredLlm = this.buildStructuredLlm(apiKey, targetModel);
    const { response: envelope } = await this.invokeLlm(structuredLlm, systemPrompt, userMessage, workbookId);

    const body: SaveSyncBody = {
      displayName: envelope.name.slice(0, 60),
      mappings: (envelope.mapping as SyncMapping) || { version: 1, tableMappings: [] },
      validateMappings: false,
    };

    const sync = await this.syncService.createSync(workbookId, body, actor);

    const createdSync = sync as AiGenerateSyncResponse['sync'];
    const entry: AiPromptHistoryEntry = {
      prompt,
      summary: envelope.summary,
      result: envelope.result,
    };
    await this.db.client.sync.update({
      where: { id: createdSync.id },
      data: { aiPromptHistory: { push: entry as never } },
    });

    const folderMap = await this.loadFolderMap(workbookId);
    const tablePairings = this.buildTablePairings(
      ((envelope.mapping as SyncMapping) || { tableMappings: [] }).tableMappings || [],
      folderMap,
    );

    const fullHistory = [entry];

    return {
      sync: sync as AiGenerateSyncResponse['sync'],
      tablePairings,
      history: JSON.stringify(fullHistory, null, 2),
      summary: envelope.summary,
      result: envelope.result,
    };
  }

  async editSyncWithPrompt(
    workbookId: WorkbookId,
    syncId: SyncId,
    prompt: string,
    actor: Actor,
    model?: string,
  ): Promise<AiGenerateSyncResponse> {
    const apiKey = this.scratchConfigService.getOpenRouterApiKeyOptional();
    if (!apiKey) {
      throw new ServiceUnavailableException('AI sync generation is not configured. Contact your administrator.');
    }

    const existingSync = await this.db.client.sync.findFirst({
      where: {
        id: syncId,
        syncTablePairs: { some: { sourceDataFolder: { workbookId } } },
      },
    });
    if (!existingSync) {
      throw new NotFoundException(`Sync ${syncId} not found`);
    }

    const history = (existingSync.aiPromptHistory as unknown as AiPromptHistoryEntry[] | null) ?? [];

    const baseSystemPrompt = await this.generateInternalAgentContext(workbookId, actor);
    let systemPrompt = this.appendPromptHistory(baseSystemPrompt, history);

    if (existingSync.mappings) {
      const currentMappingStr = JSON.stringify(existingSync.mappings, null, 2);
      systemPrompt += `\n\n## Current Sync State\nBelow is the current JSON mapping. Apply the user's requested updates to this existing structure, preserving anything they don't explicitly want removed:\n\`\`\`json\n${currentMappingStr}\n\`\`\``;
    }

    const userMessage = `User request: "${prompt}"\n\nUpdate the sync mapping and name accordingly.`;

    WSLogger.info({
      source: 'AiSyncBuilderService.editSyncWithPrompt',
      message: 'Calling LLM via OpenRouter',
      workbookId,
      syncId,
      model,
    });

    const targetModel = model || 'google/gemini-3.1-pro-preview';
    const structuredLlm = this.buildStructuredLlm(apiKey, targetModel);

    let envelope: AiSyncResponse;
    try {
      const result = await this.invokeLlm(structuredLlm, systemPrompt, userMessage, workbookId);
      envelope = result.response;
    } catch (err) {
      const failedEntry: AiPromptHistoryEntry = { prompt, error: toErrorMessage(err) };
      await this.db.client.sync.update({
        where: { id: syncId },
        data: { aiPromptHistory: { push: failedEntry as never } },
      });
      throw err;
    }

    let updatedSync: AiGenerateSyncResponse['sync'];

    if (envelope.result === 'success' && envelope.mapping) {
      const body: SaveSyncBody = {
        displayName: envelope.name.slice(0, 60),
        mappings: envelope.mapping as SyncMapping,
        validateMappings: false,
      };

      try {
        updatedSync = (await this.syncService.updateSync(
          workbookId,
          syncId,
          body,
          actor,
        )) as AiGenerateSyncResponse['sync'];
      } catch (err) {
        const failedEntry: AiPromptHistoryEntry = { prompt, error: toErrorMessage(err) };
        await this.db.client.sync.update({
          where: { id: syncId },
          data: { aiPromptHistory: { push: failedEntry as never } },
        });
        throw err;
      }
    } else {
      updatedSync = existingSync as unknown as AiGenerateSyncResponse['sync'];
    }

    const successEntry: AiPromptHistoryEntry = {
      prompt,
      summary: envelope.summary,
      result: envelope.result,
    };
    await this.db.client.sync.update({
      where: { id: syncId },
      data: { aiPromptHistory: { push: successEntry as never } },
    });

    const folderMap = await this.loadFolderMap(workbookId);
    const tablePairings = this.buildTablePairings(
      ((envelope.mapping as SyncMapping) || { tableMappings: [] }).tableMappings || [],
      folderMap,
    );

    const fullHistory = [...history, successEntry];

    return {
      sync: updatedSync,
      tablePairings,
      history: JSON.stringify(fullHistory, null, 2),
      summary: envelope.summary,
      result: envelope.result,
    };
  }
}
