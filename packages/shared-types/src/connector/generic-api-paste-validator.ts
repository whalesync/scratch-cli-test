/**
 * Validate + parse JSON pasted from the user's AI (the round-trip from the
 * "Paste config from AI" button in the custom modal).
 *
 * Lives in shared-types so the client modal, server controllers, and any
 * future CI validators all share one implementation. Has no runtime deps
 * beyond TypeScript and the GenericApi types in the same package.
 *
 * Behavior matches the impl plan (PR 4 section, "Paste config from AI"):
 *   - Strip ```json / ``` markdown fences and extract the first {...} block.
 *   - Parse JSON.
 *   - Validate against the expected GenericApiConnectorExtras shape.
 *   - On failure, return a structured error with a fix-it message the user
 *     can copy back to their AI (manually — caller renders a "Copy fix-it"
 *     button; we do NOT auto-overwrite the clipboard, per eng review).
 */

import {
  GenericApiAuthHeaderStyle,
  GenericApiConnectorExtras,
  GenericApiGraphqlEndpoint,
  GenericApiRestEndpoint,
} from './metadata';

export type PasteValidationResult =
  | { ok: true; extras: GenericApiConnectorExtras }
  | { ok: false; error: PasteValidationError };

export interface PasteValidationError {
  message: string;
  stage: 'extract' | 'parse' | 'shape';
  fixItMessage: string;
}

export function validatePastedConfig(raw: string, apiType: 'rest' | 'graphql'): PasteValidationResult {
  const extracted = extractJsonBlock(raw);
  if (extracted === null) {
    return failure({
      stage: 'extract',
      message: "Couldn't find a JSON object in the pasted text.",
      fixItMessage: buildFixItMessage({
        problem: "the text you gave me wasn't JSON I could parse — there was no { ... } block in your response.",
        apiType,
      }),
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(extracted);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown parse error';
    return failure({
      stage: 'parse',
      message: `JSON parse error: ${msg}`,
      fixItMessage: buildFixItMessage({
        problem: `the JSON you gave me failed to parse: ${msg}`,
        apiType,
      }),
    });
  }

  const shapeError = validateShape(parsed, apiType);
  if (shapeError) {
    return failure({
      stage: 'shape',
      message: shapeError,
      fixItMessage: buildFixItMessage({
        problem: `the JSON you gave me failed validation: ${shapeError}`,
        apiType,
      }),
    });
  }

  return { ok: true, extras: parsed as GenericApiConnectorExtras };
}

export function extractJsonBlock(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf('{');
  if (firstBrace === -1) return null;
  const block = balanceBraces(trimmed, firstBrace);
  return block ?? trimmed.slice(firstBrace);
}

function balanceBraces(input: string, startIdx: number): string | null {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = startIdx; i < input.length; i++) {
    const c = input[i];
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escapeNext = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        return input.slice(startIdx, i + 1);
      }
    }
  }
  return null;
}

const VALID_AUTH_HEADERS: Record<string, GenericApiAuthHeaderStyle> = {
  bearer: 'bearer',
  Bearer: 'bearer',
  BEARER: 'bearer',
  token: 'token',
  Token: 'token',
  TOKEN: 'token',
  raw: 'raw',
  Raw: 'raw',
  RAW: 'raw',
  'x-api-key': 'custom-header',
  'X-API-Key': 'custom-header',
  'X-Api-Key': 'custom-header',
  custom: 'custom-header',
  'custom-header': 'custom-header',
};

function validateShape(parsed: unknown, apiType: 'rest' | 'graphql'): string | null {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'Top-level value must be a JSON object.';
  }
  const obj = parsed as Record<string, unknown>;

  // authHeader accepts two shapes:
  //   - Wire (AI output): string like "Bearer" — gets coerced to canonical.
  //   - Canonical: object { style, headerName? } — used by stored fixtures
  //     and any custom header name other than the literal "X-API-Key".
  const authHeaderResult = parseAuthHeader(obj['authHeader']);
  if (typeof authHeaderResult === 'string') return authHeaderResult;

  const endpointsRaw = obj['endpoints'];
  if (!Array.isArray(endpointsRaw)) {
    return 'endpoints must be an array.';
  }
  if (endpointsRaw.length === 0) {
    return 'endpoints array is empty — at least one endpoint is required.';
  }

  for (let i = 0; i < endpointsRaw.length; i++) {
    const epError = validateEndpointShape(endpointsRaw[i], i, apiType);
    if (epError) return epError;
  }

  obj['authHeader'] = authHeaderResult;
  obj['apiType'] = apiType;

  for (let i = 0; i < endpointsRaw.length; i++) {
    const ep = endpointsRaw[i] as Record<string, unknown>;
    if (typeof ep['id'] !== 'string' || ep['id'] === '') {
      ep['id'] = generateEndpointId();
    }
  }

  return null;
}

/**
 * Normalize the authHeader field. Returns a canonical `{ style, headerName? }`
 * object on success, or an error-message string on failure.
 *
 * Two input shapes are accepted:
 *   - String (wire / AI shape):  "Bearer", "X-API-Key", etc.
 *   - Object (canonical shape):  { style, headerName?, valuePrefix? } — valuePrefix
 *     is the optional scheme word prepended to the key (e.g. "Klaviyo-API-Key").
 */
function parseAuthHeader(
  raw: unknown,
): { style: GenericApiAuthHeaderStyle; headerName?: string; valuePrefix?: string } | string {
  if (typeof raw === 'string') {
    if (!(raw in VALID_AUTH_HEADERS)) {
      return `authHeader must be one of: Bearer, Token, raw, X-API-Key. Got: ${JSON.stringify(raw)}.`;
    }
    const style = VALID_AUTH_HEADERS[raw];
    return style === 'custom-header' ? { style: 'custom-header', headerName: 'X-API-Key' } : { style };
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const style = obj['style'];
    if (style !== 'bearer' && style !== 'token' && style !== 'raw' && style !== 'custom-header') {
      return `authHeader.style must be one of: bearer, token, raw, custom-header. Got: ${JSON.stringify(style)}.`;
    }
    if (style === 'custom-header') {
      const headerName = obj['headerName'];
      if (typeof headerName !== 'string' || headerName === '') {
        return 'authHeader.headerName is required when style is "custom-header".';
      }
      // Optional scheme/prefix prepended to the key (e.g. Klaviyo-API-Key, SSWS).
      const valuePrefix = obj['valuePrefix'];
      if (valuePrefix !== undefined && typeof valuePrefix !== 'string') {
        return 'authHeader.valuePrefix must be a string when provided.';
      }
      return valuePrefix ? { style: 'custom-header', headerName, valuePrefix } : { style: 'custom-header', headerName };
    }
    return { style };
  }
  return `authHeader must be a string (e.g. "Bearer") or an object like { "style": "custom-header", "headerName": "Authorization", "valuePrefix": "Klaviyo-API-Key" }. Got: ${JSON.stringify(raw)}.`;
}

function validateEndpointShape(ep: unknown, index: number, apiType: 'rest' | 'graphql'): string | null {
  if (ep === null || typeof ep !== 'object' || Array.isArray(ep)) {
    return `endpoints[${index}] must be an object.`;
  }
  const obj = ep as Record<string, unknown>;

  const url = obj['url'];
  if (typeof url !== 'string' || url === '') {
    return `endpoints[${index}].url is required and must be a non-empty string.`;
  }
  try {
    new URL(url);
  } catch {
    return `endpoints[${index}].url is not a valid URL: ${url}`;
  }

  if (apiType === 'rest') {
    const method = obj['method'];
    if (method !== 'GET' && method !== 'POST') {
      return `endpoints[${index}].method must be "GET" or "POST". Got: ${JSON.stringify(method)}.`;
    }
  } else {
    const query = obj['query'];
    if (typeof query !== 'string' || query === '') {
      return `endpoints[${index}].query is required and must be a non-empty string (GraphQL).`;
    }
  }

  const assetError = validateAssetShape(obj['asset'], index);
  if (assetError) return assetError;

  return null;
}

/**
 * Validate the optional `asset` block on an endpoint (GenericApiAssetMapping).
 * Only `urlPath` is required; the rest are optional dot-paths / a boolean.
 * Returns an error message or null. Absent `asset` is valid (most endpoints
 * aren't file collections).
 */
function validateAssetShape(asset: unknown, index: number): string | null {
  if (asset === undefined) return null;
  if (asset === null || typeof asset !== 'object' || Array.isArray(asset)) {
    return `endpoints[${index}].asset must be an object like { "urlPath": "url", "filenamePath": "name" }.`;
  }
  const obj = asset as Record<string, unknown>;

  if (typeof obj['urlPath'] !== 'string' || obj['urlPath'] === '') {
    return `endpoints[${index}].asset.urlPath is required and must be a non-empty string (the dot-path to the file's download URL).`;
  }
  for (const key of ['filenamePath', 'mimeTypePath', 'sizePath'] as const) {
    const value = obj[key];
    if (value !== undefined && (typeof value !== 'string' || value === '')) {
      return `endpoints[${index}].asset.${key} must be a non-empty string when provided.`;
    }
  }
  if (obj['urlExpires'] !== undefined && typeof obj['urlExpires'] !== 'boolean') {
    return `endpoints[${index}].asset.urlExpires must be a boolean when provided.`;
  }

  return null;
}

function buildFixItMessage(args: { problem: string; apiType: 'rest' | 'graphql' }): string {
  const exampleShape =
    args.apiType === 'rest'
      ? `{
  "authHeader": "Bearer",
  "endpoints": [
    { "name": "Projects", "method": "GET", "url": "https://api.example.com/v1/projects" }
  ]
}`
      : `{
  "authHeader": "Bearer",
  "endpoints": [
    { "name": "Issues", "url": "https://api.example.com/graphql", "query": "query Issues($after: String) { ... }" }
  ]
}`;

  return `Hi — I tried to paste your JSON into Scratch but ${args.problem}

Please regenerate the JSON addressing this. Format reminder:

\`\`\`json
${exampleShape}
\`\`\`

Wrap the JSON in a fenced \`\`\`json ... \`\`\` block so it's easy to extract. Don't include any prose inside the block.`;
}

function failure(error: PasteValidationError): PasteValidationResult {
  return { ok: false, error };
}

function generateEndpointId(): string {
  return `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

export type { GenericApiGraphqlEndpoint, GenericApiRestEndpoint };
