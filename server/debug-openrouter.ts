import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import * as dotenv from 'dotenv';
import { z } from 'zod';
dotenv.config();

const apiKey = process.env.SCRATCH_OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY;

import { syncMappingSchema } from './src/sync/sync-mapping.schema';

const aiSyncResponseSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(60)
    .describe(
      'A concise, descriptive name for this sync in title case. Prefer ≤35 chars when a clear name fits; max 60.',
    ),
  mapping: syncMappingSchema.describe('The SyncMapping object as defined in the schema.'),
});

async function main() {
  if (!apiKey) {
    console.error('No API key found in env.');
    return;
  }

  process.env.LANGCHAIN_VERBOSE = 'true';

  const llm = new ChatOpenAI({
    apiKey,
    modelName: 'anthropic/claude-3.5-sonnet',
    configuration: { baseURL: 'https://openrouter.ai/api/v1' },
    maxRetries: 0,
  });

  const structuredLlm = llm.withStructuredOutput(aiSyncResponseSchema, {
    name: 'ai_sync_response',
    method: 'jsonSchema',
  });

  try {
    const res = await structuredLlm.invoke([new SystemMessage('Return a dummy response'), new HumanMessage('Do it')]);
    console.log('Success:', res);
  } catch (err: any) {
    console.error('Failed!');
    if (err.error) {
      console.error(JSON.stringify(err.error, null, 2));
    } else {
      console.error(err.message, err.response?.data);
    }
  }
}

main();
