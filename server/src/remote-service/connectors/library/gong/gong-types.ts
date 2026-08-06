/**
 * Types for the Gong REST API (v2).
 *
 * Gong is a revenue-intelligence platform: it records, transcribes, and
 * AI-analyzes sales calls. The public API is read-mostly — analyzed call data,
 * users, workspaces, library folders, scorecard definitions — and the Scratch
 * connector is strictly READ-ONLY (the API has no update surface for any of
 * these entities; its only writes are call ingestion and CRM upload, which are
 * service-side integrations, not record edits).
 *
 * API reference: https://gong.app.gong.io/settings/api/documentation (also
 * https://help.gong.io/docs/receive-access-to-the-api). Base URL is
 * instance-specific (e.g. https://us02-12345.api.gong.io).
 */

/** The fixed entity families the connector exposes as tables. */
export const GongEntityType = {
  CALLS: 'calls',
  TRANSCRIPTS: 'transcripts',
  USERS: 'users',
  WORKSPACES: 'workspaces',
  LIBRARY_FOLDERS: 'library-folders',
  SCORECARDS: 'scorecards',
} as const;
export type GongEntityType = (typeof GongEntityType)[keyof typeof GongEntityType];

/** Entity families scoped to a Gong workspace (workspace id rides in remoteId[1]). */
export const WORKSPACE_SCOPED_ENTITY_TYPES: ReadonlySet<GongEntityType> = new Set([
  GongEntityType.CALLS,
  GongEntityType.TRANSCRIPTS,
  GongEntityType.LIBRARY_FOLDERS,
  GongEntityType.SCORECARDS,
]);

/**
 * The `records` transport envelope Gong returns on paginated list responses.
 * `cursor` is present only when another page exists. This wrapper is stripped
 * before records are stored (sanctioned transport-wrapper exception to the
 * Connector Prime Directive).
 */
export interface GongRecordsEnvelope {
  totalRecords: number;
  currentPageSize: number;
  currentPageNumber: number;
  cursor?: string;
}

export interface GongListResponseBase {
  requestId: string;
  records?: GongRecordsEnvelope;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export interface GongUser {
  id: string;
  emailAddress: string;
  created: string;
  active: boolean;
  emailAliases: string[];
  trustedEmailAddress: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  phoneNumber: string | null;
  extension: string | null;
  personalMeetingUrls: string[];
  settings: Record<string, unknown>;
  managerId: string | null;
  meetingConsentPageUrl: string | null;
  conferencingProviders: unknown;
  spokenLanguages: unknown[];
}

export interface GongListUsersResponse extends GongListResponseBase {
  users: GongUser[];
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export interface GongWorkspace {
  id: string;
  name: string;
  description: string | null;
}

export interface GongListWorkspacesResponse {
  requestId: string;
  workspaces: GongWorkspace[];
}

// ---------------------------------------------------------------------------
// Library folders
// ---------------------------------------------------------------------------

export interface GongLibraryFolder {
  id: string;
  name: string;
  parentFolderId: string | null;
  createdBy: string | null;
  updated: string;
}

export interface GongListLibraryFoldersResponse {
  requestId: string;
  folders: GongLibraryFolder[];
}

// ---------------------------------------------------------------------------
// Scorecards (definitions, from /v2/settings/scorecards)
// ---------------------------------------------------------------------------

export interface GongScorecard {
  scorecardId: string;
  scorecardName: string;
  workspaceId: string;
  enabled?: boolean;
  updaterUserId?: string;
  created?: string;
  updated?: string;
  questions?: unknown[];
}

export interface GongListScorecardsResponse {
  requestId: string;
  scorecards: GongScorecard[];
}

// ---------------------------------------------------------------------------
// Calls (extensive shape — POST /v2/calls/extensive)
// ---------------------------------------------------------------------------

/**
 * Flat per-call metadata (identical to the GET /v2/calls item shape).
 * Inside the extensive response it sits under `metaData`.
 */
export interface GongCallMetaData {
  id: string;
  url?: string;
  title?: string | null;
  scheduled?: string | null;
  started?: string | null;
  duration?: number | null;
  primaryUserId?: string | null;
  direction?: string | null;
  system?: string | null;
  scope?: string | null;
  media?: string | null;
  language?: string | null;
  workspaceId?: string | null;
  sdrDisposition?: string | null;
  clientUniqueId?: string | null;
  customData?: string | null;
  purpose?: string | null;
  meetingUrl?: string | null;
  isPrivate?: boolean | null;
  calendarEventId?: string | null;
}

/**
 * One record from POST /v2/calls/extensive, stored verbatim. Which optional
 * blocks are present depends on the contentSelector and on how far Gong's
 * async analysis of the call has progressed.
 */
export interface GongCallExtensive {
  metaData: GongCallMetaData;
  context?: unknown[];
  parties?: unknown[];
  content?: Record<string, unknown>;
  interaction?: Record<string, unknown>;
  collaboration?: Record<string, unknown>;
  media?: Record<string, unknown>;
}

export interface GongListCallsExtensiveResponse extends GongListResponseBase {
  calls: GongCallExtensive[];
}

// ---------------------------------------------------------------------------
// Transcripts (POST /v2/calls/transcript)
// ---------------------------------------------------------------------------

/** One call's transcript: monologues per speaker, sentences with ms offsets. */
export interface GongCallTranscript {
  callId: string;
  transcript: unknown[];
}

export interface GongListTranscriptsResponse extends GongListResponseBase {
  callTranscripts: GongCallTranscript[];
}
