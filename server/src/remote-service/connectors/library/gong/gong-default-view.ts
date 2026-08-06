import {
  TablePropertyType,
  TableView,
  TableViewBannerGroup,
  TableViewCol,
  TransformerTypes,
} from '@spinner/shared-types';
import { BaseJsonTableSpec } from '../../types';
import { gongForeignKeyLinkedTableId } from './gong-json-schema';
import { GongEntityType } from './gong-types';

/**
 * Default views for the Gong connector.
 *
 * Editorial stance: Gong records are ANALYSIS OUTPUT, so the view leads with
 * what a revenue team actually scans — who talked to whom, when, for how long,
 * and what Gong's AI concluded — and folds the machinery (ids, ingestion
 * bookkeeping, expiring media URLs) away behind hidden columns. Every column
 * is read-only, mirroring the API.
 *
 * The banner groups mirror the API's OWN structural containers on the
 * extensive call record (`content`, `interaction`) — not invented themes.
 * Display transformers flatten Gong's nested arrays (topics, trackers,
 * key points, transcript monologues) to readable text; the stored value
 * stays the verbatim array (Prime Directive), and Live Export sees a
 * `logicalType: 'string'` so text destinations receive flat text.
 */

/** Parsed identity of a Gong table (mirrors listTables' remoteId encoding). */
export interface GongParsedTableId {
  entityType: GongEntityType;
  workspaceId?: string;
}

export function buildGongDefaultView(spec: BaseJsonTableSpec, parsed: GongParsedTableId): TableView | undefined {
  switch (parsed.entityType) {
    case GongEntityType.CALLS:
      return buildCallsView();
    case GongEntityType.TRANSCRIPTS:
      return buildTranscriptsView(parsed.workspaceId ?? '');
    case GongEntityType.USERS:
      return buildUsersView();
    case GongEntityType.WORKSPACES:
      return buildWorkspacesView();
    case GongEntityType.LIBRARY_FOLDERS:
      return buildLibraryFoldersView(parsed.workspaceId ?? '');
    case GongEntityType.SCORECARDS:
      return buildScorecardsView();
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Column helpers (every Gong column is read-only)
// ---------------------------------------------------------------------------

function col(path: string, name: string, type?: TablePropertyType, extras: Partial<TableViewCol> = {}): TableViewCol {
  return { kind: 'col', path, name, type, readonly: true, ...extras };
}

function hiddenCol(path: string, name: string, type?: TablePropertyType): TableViewCol {
  return col(path, name, type, { hidden: true });
}

/**
 * A column whose raw value is an array of objects, flattened for display (and
 * for Live Export) by joining one text-bearing key from each element.
 * Discrete values (names, topics) join with commas; running prose (transcript
 * sentences) joins with spaces.
 */
function flattenedArrayCol(
  path: string,
  name: string,
  elementTextExpression: string,
  arrayHandling: 'join_comma' | 'join_space' = 'join_comma',
): TableViewCol {
  return col(path, name, 'string', {
    logicalType: 'string',
    displayTransformer: {
      type: TransformerTypes.JSONPath,
      options: { expression: elementTextExpression, arrayHandling },
    },
  });
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

function buildCallsView(): TableView {
  const aiAnalysisGroup: TableViewBannerGroup = {
    kind: 'banner-group',
    name: 'AI Analysis',
    cols: [
      col('content.brief', 'Brief', 'string', { logicalType: 'string' }),
      flattenedArrayCol('content.keyPoints', 'Key Points', '$[*].text'),
      flattenedArrayCol('content.topics', 'Topics', '$[*].name'),
      flattenedArrayCol('content.trackers', 'Trackers', '$[*].name'),
      col('content.callOutcome', 'Call Outcome', 'object'),
      col('content.outline', 'Outline', 'object', { hidden: true }),
      col('content.highlights', 'Highlights', 'object', { hidden: true }),
      col('content.pointsOfInterest', 'Points of Interest', 'object', { hidden: true }),
      col('content.structure', 'Structure', 'object', { hidden: true }),
    ],
  };

  const interactionGroup: TableViewBannerGroup = {
    kind: 'banner-group',
    name: 'Interaction',
    hidden: true,
    cols: [
      col('interaction.speakers', 'Speaker Talk Time', 'object'),
      col('interaction.questions', 'Questions', 'object'),
      col('interaction.interactionStats', 'Interaction Stats', 'object'),
      col('interaction.video', 'Video Segments', 'object'),
    ],
  };

  return {
    name: 'Default',
    cols: [
      col('metaData.title', 'Title', 'string'),
      col('metaData.started', 'Started', 'date'),
      col('metaData.duration', 'Duration (s)', 'number', { logicalType: 'number' }),
      col('metaData.direction', 'Direction', 'string'),
      col('metaData.primaryUserId', 'Host', 'string', {
        foreignKey: {
          linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.USERS),
          linkedTableRemoteId: [GongEntityType.USERS],
          isSingleValued: true,
        },
      }),
      flattenedArrayCol('parties', 'Participants', '$[*].name'),
      col('metaData.scope', 'Scope', 'string'),
      col('metaData.media', 'Media', 'string'),
      aiAnalysisGroup,
      col('metaData.url', 'Gong Link', 'url'),
      col('metaData.system', 'Source System', 'string', { hidden: true }),
      col('metaData.language', 'Language', 'string', { hidden: true }),
      col('metaData.purpose', 'Purpose', 'string', { hidden: true }),
      col('metaData.sdrDisposition', 'SDR Disposition', 'string', { hidden: true }),
      col('metaData.meetingUrl', 'Meeting URL', 'url', { hidden: true }),
      col('metaData.isPrivate', 'Private', 'checkbox', { hidden: true }),
      col('metaData.scheduled', 'Scheduled', 'date', { hidden: true }),
      interactionGroup,
      col('collaboration.publicComments', 'Public Comments', 'object', { hidden: true }),
      col('context', 'CRM Context', 'object', { hidden: true }),
      col('media', 'Media URLs', 'object', { hidden: true }),
      hiddenCol('metaData.id', 'Call ID'),
      col('metaData.workspaceId', 'Workspace', 'string', {
        hidden: true,
        foreignKey: {
          linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.WORKSPACES),
          linkedTableRemoteId: [GongEntityType.WORKSPACES],
          isSingleValued: true,
        },
      }),
      hiddenCol('metaData.clientUniqueId', 'Client Unique ID'),
      hiddenCol('metaData.customData', 'Custom Data'),
      hiddenCol('metaData.calendarEventId', 'Calendar Event ID'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

function buildTranscriptsView(workspaceId: string): TableView {
  return {
    name: 'Default',
    cols: [
      col('callId', 'Call', 'string', {
        foreignKey: {
          linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.CALLS),
          linkedTableRemoteId: [GongEntityType.CALLS, workspaceId],
          isSingleValued: true,
        },
      }),
      // Render the monologue array as a standard SubRip (SRT) document with
      // "Speaker N:" labels — one cue per timed sentence. The codec's toCore
      // half drives BOTH the grid display and a Live Export's source value;
      // the stored record keeps the verbatim monologue array.
      col('transcript', 'Transcript', 'string', {
        logicalType: 'string',
        codec: {
          toCore: {
            type: TransformerTypes.TranscriptToSrt,
            options: {
              speakerPath: 'speakerId',
              sentencesPath: 'sentences',
              textPath: 'text',
              startMsPath: 'start',
              endMsPath: 'end',
            },
          },
        },
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

function buildUsersView(): TableView {
  return {
    name: 'Default',
    cols: [
      col('emailAddress', 'Email', 'string'),
      col('firstName', 'First Name', 'string'),
      col('lastName', 'Last Name', 'string'),
      col('title', 'Job Title', 'string'),
      col('active', 'Active', 'checkbox'),
      col('managerId', 'Manager', 'string', {
        foreignKey: {
          linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.USERS),
          linkedTableRemoteId: [GongEntityType.USERS],
          isSingleValued: true,
        },
      }),
      col('phoneNumber', 'Phone', 'string', { hidden: true }),
      col('extension', 'Extension', 'string', { hidden: true }),
      col('created', 'Added to Gong', 'date', { hidden: true }),
      col('emailAliases', 'Email Aliases', 'object', { hidden: true }),
      col('trustedEmailAddress', 'Trusted Email', 'string', { hidden: true }),
      col('personalMeetingUrls', 'Personal Meeting URLs', 'object', { hidden: true }),
      col('settings', 'Data-Capture Settings', 'object', { hidden: true }),
      col('meetingConsentPageUrl', 'Consent Page URL', 'url', { hidden: true }),
      col('conferencingProviders', 'Conferencing Providers', 'object', { hidden: true }),
      col('spokenLanguages', 'Spoken Languages', 'object', { hidden: true }),
      hiddenCol('id', 'User ID'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

function buildWorkspacesView(): TableView {
  return {
    name: 'Default',
    cols: [col('name', 'Name', 'string'), col('description', 'Description', 'string'), hiddenCol('id', 'Workspace ID')],
  };
}

// ---------------------------------------------------------------------------
// Library folders
// ---------------------------------------------------------------------------

function buildLibraryFoldersView(workspaceId: string): TableView {
  return {
    name: 'Default',
    cols: [
      col('name', 'Name', 'string'),
      col('parentFolderId', 'Parent Folder', 'string', {
        foreignKey: {
          linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.LIBRARY_FOLDERS),
          linkedTableRemoteId: [GongEntityType.LIBRARY_FOLDERS, workspaceId],
          isSingleValued: true,
        },
      }),
      col('createdBy', 'Created By', 'string', {
        foreignKey: {
          linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.USERS),
          linkedTableRemoteId: [GongEntityType.USERS],
          isSingleValued: true,
        },
      }),
      col('updated', 'Updated', 'date'),
      hiddenCol('id', 'Folder ID'),
    ],
  };
}

// ---------------------------------------------------------------------------
// Scorecards
// ---------------------------------------------------------------------------

function buildScorecardsView(): TableView {
  return {
    name: 'Default',
    cols: [
      col('scorecardName', 'Name', 'string'),
      col('enabled', 'Enabled', 'checkbox'),
      col('questions', 'Questions', 'object'),
      col('updaterUserId', 'Last Updated By', 'string', {
        foreignKey: {
          linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.USERS),
          linkedTableRemoteId: [GongEntityType.USERS],
          isSingleValued: true,
        },
      }),
      col('created', 'Created', 'date', { hidden: true }),
      col('updated', 'Updated', 'date', { hidden: true }),
      col('workspaceId', 'Workspace', 'string', {
        hidden: true,
        foreignKey: {
          linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.WORKSPACES),
          linkedTableRemoteId: [GongEntityType.WORKSPACES],
          isSingleValued: true,
        },
      }),
      hiddenCol('scorecardId', 'Scorecard ID'),
    ],
  };
}
