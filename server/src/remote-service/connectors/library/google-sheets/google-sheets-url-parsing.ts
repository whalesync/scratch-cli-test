import { isGoogleSheetsConnectorExtras } from '@spinner/shared-types';

/**
 * Spreadsheet URL/id parsing, shared by the table picker's paste-a-URL search
 * (google-sheets-connector.ts) and the OAuth connect form's spreadsheet-URL
 * field (oauth.service.ts persists the parsed ids into
 * `ConnectorAccount.extras.spreadsheetIds`). Kept in its own module so the
 * OAuth service doesn't have to import the whole connector.
 */

/**
 * Regex source for the connect form's per-row URL validation
 * (`ConnectorSettingDefinition.itemPattern`) — a cheap "is this really a
 * Google Sheets URL copied from the address bar" shape check, evaluated
 * client-side with `new RegExp(...)`. Deliberately stricter than
 * `parseSpreadsheetIdFromUrlOrId` (no bare ids: the form asks for URLs), and
 * deliberately lenient about what follows the id (`/edit#gid=0`, query params,
 * or nothing).
 */
export const GOOGLE_SHEETS_SPREADSHEET_URL_INPUT_PATTERN =
  '^https://docs\\.google\\.com/spreadsheets/(?:u/\\d+/)?d/[a-zA-Z0-9_-]{10,}';

/**
 * Parse a spreadsheet id out of a pasted URL
 * (https://docs.google.com/spreadsheets/d/<id>/edit#gid=0) or a bare id.
 */
export function parseSpreadsheetIdFromUrlOrId(text: string): string | null {
  const trimmed = text.trim();
  const urlMatch = trimmed.match(/\/spreadsheets\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]{10,})/);
  if (urlMatch) return urlMatch[1];
  // A bare spreadsheet id (they run ~44 chars; require enough length that
  // ordinary search words never false-positive).
  if (/^[a-zA-Z0-9_-]{25,}$/.test(trimmed)) return trimmed;
  return null;
}

/**
 * Split the raw, user-entered spreadsheet-URL string from the Google Sheets
 * connect form into the VERBATIM URL rows to persist in
 * `extras.spreadsheetUrls`. Splits on commas and any whitespace (Sheets URLs
 * contain neither), keeps only tokens that actually parse to a spreadsheet id
 * (full URLs or bare ids — junk is silently dropped, the field is seed data),
 * and dedupes by parsed id (first token wins). Returns `[]` for empty input.
 */
export function splitGoogleSheetsSpreadsheetUrlInput(rawSpreadsheetUrls: string | undefined): string[] {
  if (!rawSpreadsheetUrls) return [];
  const verbatimUrlRowBySpreadsheetId = new Map<string, string>();
  for (const urlOrIdToken of rawSpreadsheetUrls.split(/[\s,]+/)) {
    const spreadsheetId = parseSpreadsheetIdFromUrlOrId(urlOrIdToken);
    if (spreadsheetId !== null && !verbatimUrlRowBySpreadsheetId.has(spreadsheetId)) {
      verbatimUrlRowBySpreadsheetId.set(spreadsheetId, urlOrIdToken.trim());
    }
  }
  return [...verbatimUrlRowBySpreadsheetId.values()];
}

/**
 * Derive the deduped spreadsheet ids from a ConnectorAccount's `extras` JSON
 * (which stores the user's URL rows verbatim — see GoogleSheetsConnectorExtras).
 * Null/foreign/malformed shapes and unparseable rows → dropped.
 */
export function spreadsheetIdsFromConnectorAccountExtras(extras: unknown): string[] {
  if (!isGoogleSheetsConnectorExtras(extras)) return [];
  const spreadsheetIds = extras.spreadsheetUrls
    .map((spreadsheetUrl) => parseSpreadsheetIdFromUrlOrId(spreadsheetUrl))
    .filter((spreadsheetId): spreadsheetId is string => spreadsheetId !== null);
  return Array.from(new Set(spreadsheetIds));
}
