/**
 * AI prompt asset selector. Bundles the markdown prompt files at build time
 * so the runtime returns the right one for a given apiType.
 *
 * Why bundled (vs read from disk at request time): the prompts are tiny,
 * change rarely, and avoiding fs I/O makes the endpoint trivial to test +
 * cache. Bump the version suffix (v1 → v2) when the output schema changes
 * so consumers that depend on a specific shape can pin.
 */

import { GRAPHQL_PROMPT_V1 } from './graphql-prompt-v1';
import { REST_PROMPT_V1 } from './rest-prompt-v1';

export const CURRENT_REST_PROMPT_VERSION = 'v1';
export const CURRENT_GRAPHQL_PROMPT_VERSION = 'v1';

/**
 * Get the AI prompt text for a given apiType. Used by the
 * GET /api/connectors/generic-api/ai-prompt endpoint (PR 4).
 */
export function getAiPrompt(apiType: 'rest' | 'graphql'): { version: string; text: string } {
  if (apiType === 'graphql') {
    return { version: CURRENT_GRAPHQL_PROMPT_VERSION, text: GRAPHQL_PROMPT_V1 };
  }
  return { version: CURRENT_REST_PROMPT_VERSION, text: REST_PROMPT_V1 };
}
