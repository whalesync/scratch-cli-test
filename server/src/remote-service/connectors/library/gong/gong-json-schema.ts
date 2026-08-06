import { TSchema, Type } from '@sinclair/typebox';
import { X_SCRATCH_AGENT_INSTRUCTIONS, X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import { sanitizeForTableWsId } from '../../ids';
import { BaseJsonTableSpec, EntityId, dotPath } from '../../types';
import { GongEntityType, WORKSPACE_SCOPED_ENTITY_TYPES } from './gong-types';

/**
 * Schema builders for the Gong connector — one static schema per entity family.
 *
 * Gong has no schema-discovery endpoint, so these are hardcoded from the API
 * reference (the sanctioned exception to dynamic discovery). Every field is
 * read-only: the Gong API offers no update surface for any entity the
 * connector exposes, so the whole connector is a read-only mirror.
 *
 * The builders deliberately declare NO `required` fields beyond the id: Gong
 * omits blocks it hasn't computed (call analysis is asynchronous) and returns
 * explicit nulls elsewhere, so over-declaring `required` would make freshly
 * pulled records fail their own schema (`enforce_schema`).
 */

/**
 * The stable wsId for an entity table. Company-scoped entities use the bare
 * entity key; workspace-scoped entities append the workspace id so multiple
 * workspaces never collide. Schema builders use the same function to point
 * foreign keys at the right table.
 */
export function gongTableWsId(entityType: GongEntityType, workspaceId?: string): string {
  if (WORKSPACE_SCOPED_ENTITY_TYPES.has(entityType) && workspaceId !== undefined) {
    return sanitizeForTableWsId(`${entityType}-${workspaceId}`);
  }
  return sanitizeForTableWsId(entityType);
}

/**
 * The token a foreign key uses to name its target table. The create-plan
 * generator binds a FK by matching this against the TARGET folder's
 * `DataFolder.tableId` candidate tokens (bare segments + dot-joined suffixes —
 * see `linkedTableIdCandidateTokensForRemoteTableId`), so it must be the bare
 * remoteId entity segment (e.g. 'calls', 'users'), NEVER the sanitized wsId
 * (the Attio DEV-11052 lesson). The exact target additionally rides in
 * `linkedTableRemoteId` for consumers that bind by array equality; with
 * multiple Gong workspaces in one plan the bare token alone is ambiguous and
 * the remote-id array is what disambiguates.
 */
export function gongForeignKeyLinkedTableId(entityType: GongEntityType): string {
  return entityType;
}

/** Every Gong field is read-only; this wraps a schema options object with the flag. */
function readonlyOptions(options: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...options, [X_SCRATCH_READONLY]: true };
}

function readonlyString(options: Record<string, unknown> = {}): TSchema {
  return Type.String(readonlyOptions(options));
}

function readonlyNullableString(options: Record<string, unknown> = {}): TSchema {
  return Type.Union([Type.String(), Type.Null()], readonlyOptions(options));
}

function readonlyNullableNumber(options: Record<string, unknown> = {}): TSchema {
  return Type.Union([Type.Number(), Type.Null()], readonlyOptions(options));
}

function readonlyNullableBoolean(options: Record<string, unknown> = {}): TSchema {
  return Type.Union([Type.Boolean(), Type.Null()], readonlyOptions(options));
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

/**
 * The flat metadata block of a call (shape shared by GET /v2/calls and the
 * `metaData` block of POST /v2/calls/extensive).
 */
function buildCallMetaDataSchema(): TSchema {
  return Type.Object(
    {
      id: readonlyString({ description: "Gong's unique numeric call id" }),
      url: Type.Optional(readonlyNullableString({ description: 'Deep link to the call in the Gong web app' })),
      title: Type.Optional(readonlyNullableString({ description: 'Call title' })),
      scheduled: Type.Optional(
        readonlyNullableString({ format: 'date-time', description: 'Scheduled start (ISO 8601)' }),
      ),
      started: Type.Optional(readonlyNullableString({ format: 'date-time', description: 'Actual start (ISO 8601)' })),
      duration: Type.Optional(readonlyNullableNumber({ description: 'Duration in seconds' })),
      primaryUserId: Type.Optional(
        readonlyNullableString({
          description: 'The team member who hosted the call',
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
            linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.USERS),
            linkedTableRemoteId: [GongEntityType.USERS],
            isSingleValued: true,
          },
        }),
      ),
      direction: Type.Optional(readonlyNullableString({ description: 'Inbound | Outbound | Conference | Unknown' })),
      system: Type.Optional(
        readonlyNullableString({ description: 'Originating system (e.g. the telephony provider)' }),
      ),
      scope: Type.Optional(
        readonlyNullableString({ description: 'Internal (team members only) | External | Unknown' }),
      ),
      media: Type.Optional(readonlyNullableString({ description: 'Video | Audio' })),
      language: Type.Optional(readonlyNullableString({ description: 'Detected language (ISO 639-2/B code)' })),
      workspaceId: Type.Optional(
        readonlyNullableString({
          description: 'Workspace the call belongs to',
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
            linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.WORKSPACES),
            linkedTableRemoteId: [GongEntityType.WORKSPACES],
            isSingleValued: true,
          },
        }),
      ),
      sdrDisposition: Type.Optional(readonlyNullableString({ description: 'SDR call disposition' })),
      clientUniqueId: Type.Optional(
        readonlyNullableString({ description: "The originating system's own id for the call" }),
      ),
      customData: Type.Optional(readonlyNullableString({ description: 'Free-form metadata attached at ingestion' })),
      purpose: Type.Optional(readonlyNullableString({ description: 'Call purpose' })),
      meetingUrl: Type.Optional(readonlyNullableString({ description: 'Web-conference meeting URL' })),
      isPrivate: Type.Optional(readonlyNullableBoolean({ description: 'Whether the call is private' })),
      calendarEventId: Type.Optional(readonlyNullableString({ description: 'Associated calendar event id' })),
    },
    readonlyOptions({ description: 'Call metadata' }),
  );
}

/**
 * Schema for the Calls table: one record per analyzed call, stored verbatim in
 * the shape POST /v2/calls/extensive returns. The analysis blocks (`content`,
 * `interaction`, …) appear once Gong's asynchronous processing has produced
 * them — absent on a call that hasn't been analyzed (e.g. no media yet).
 */
export function buildGongCallsJsonTableSpec(
  id: EntityId,
  workspaceId: string,
  workspaceName: string,
): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      metaData: buildCallMetaDataSchema(),
      context: Type.Optional(
        Type.Array(Type.Unknown(), readonlyOptions({ description: 'Linked CRM objects (accounts, deals, …)' })),
      ),
      parties: Type.Optional(
        Type.Array(
          Type.Unknown(),
          readonlyOptions({
            description: 'Call participants (team members and external people)',
            [X_SCRATCH_AGENT_INSTRUCTIONS]:
              'Each party may carry `userId` (a Gong team member — a foreign key into the Users table), ' +
              '`emailAddress`, `name`, `title`, `affiliation` ("Internal"/"External") and a `speakerId` that ' +
              "matches the transcript's speaker ids. External participants have no userId.",
          }),
        ),
      ),
      content: Type.Optional(
        Type.Object(
          {},
          readonlyOptions({
            additionalProperties: true,
            description: "Gong's AI analysis: topics, trackers, brief, outline, highlights, key points, call outcome",
          }),
        ),
      ),
      interaction: Type.Optional(
        Type.Object(
          {},
          readonlyOptions({
            additionalProperties: true,
            description: 'Interaction stats: speaker talk time, questions, video-share segments',
          }),
        ),
      ),
      collaboration: Type.Optional(
        Type.Object(
          {},
          readonlyOptions({ additionalProperties: true, description: 'Public comments left on the call in Gong' }),
        ),
      ),
      media: Type.Optional(
        Type.Object(
          {},
          readonlyOptions({
            additionalProperties: true,
            description: 'Expiring download URLs for the audio/video media',
          }),
        ),
      ),
    },
    {
      $id: `gong/calls/${workspaceId}`,
      title: 'Calls',
      [X_SCRATCH_AGENT_INSTRUCTIONS]:
        'A Gong call record is analysis OUTPUT — every field is read-only and the analysis blocks ' +
        '(content/interaction/collaboration) only appear after Gong finishes processing the recording.',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Calls',
    schema,
    idPath: dotPath('metaData.id'),
    titlePath: dotPath('metaData.title'),
    slugPath: dotPath('metaData.title'),
    basePath: [workspaceName],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

export function buildGongTranscriptsJsonTableSpec(
  id: EntityId,
  workspaceId: string,
  workspaceName: string,
): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      callId: readonlyString({
        description: 'The call this transcript belongs to',
        [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
          linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.CALLS),
          linkedTableRemoteId: [GongEntityType.CALLS, workspaceId],
          isSingleValued: true,
        },
      }),
      transcript: Type.Array(
        Type.Unknown(),
        readonlyOptions({
          description: 'Monologues: one entry per speaker turn, each with topic and timed sentences',
          [X_SCRATCH_AGENT_INSTRUCTIONS]:
            'Each monologue is `{ speakerId, topic, sentences: [{ start, end, text }] }` with start/end in ' +
            'milliseconds from the call start. speakerId matches the `parties` entries on the call record. ' +
            'To read the conversation, concatenate sentences across monologues in order.',
        }),
      ),
    },
    {
      $id: `gong/transcripts/${workspaceId}`,
      title: 'Call Transcripts',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Call Transcripts',
    schema,
    idPath: dotPath('callId'),
    basePath: [workspaceName],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

export function buildGongUsersJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: readonlyString({ description: "Gong's unique numeric user id" }),
      emailAddress: readonlyString({ description: 'Primary email address' }),
      created: Type.Optional(
        readonlyNullableString({ format: 'date-time', description: 'When the user was added to Gong' }),
      ),
      active: Type.Optional(readonlyNullableBoolean({ description: 'Whether the user is active' })),
      emailAliases: Type.Optional(Type.Array(Type.String(), readonlyOptions({ description: 'Alias email addresses' }))),
      trustedEmailAddress: Type.Optional(readonlyNullableString({ description: 'Trusted email address' })),
      firstName: Type.Optional(readonlyNullableString({ description: 'First name' })),
      lastName: Type.Optional(readonlyNullableString({ description: 'Last name' })),
      title: Type.Optional(readonlyNullableString({ description: 'Job title' })),
      phoneNumber: Type.Optional(readonlyNullableString({ description: 'Phone number' })),
      extension: Type.Optional(readonlyNullableString({ description: 'Phone extension' })),
      personalMeetingUrls: Type.Optional(
        Type.Array(Type.String(), readonlyOptions({ description: 'Personal web-conference room URLs' })),
      ),
      settings: Type.Optional(
        Type.Object(
          {},
          readonlyOptions({
            additionalProperties: true,
            description: 'Data-capture settings (which conversations Gong records/imports for this user)',
          }),
        ),
      ),
      managerId: Type.Optional(
        readonlyNullableString({
          description: "The user's manager",
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
            linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.USERS),
            linkedTableRemoteId: [GongEntityType.USERS],
            isSingleValued: true,
          },
        }),
      ),
      meetingConsentPageUrl: Type.Optional(readonlyNullableString({ description: 'Recording-consent page URL' })),
      conferencingProviders: Type.Optional(
        Type.Unknown(readonlyOptions({ description: 'Configured conferencing providers' })),
      ),
      spokenLanguages: Type.Optional(
        Type.Array(Type.Unknown(), readonlyOptions({ description: 'Languages the user speaks (with confidence)' })),
      ),
    },
    {
      $id: 'gong/users',
      title: 'Users',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Users',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('emailAddress'),
    slugPath: dotPath('emailAddress'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Workspaces
// ---------------------------------------------------------------------------

export function buildGongWorkspacesJsonTableSpec(id: EntityId): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: readonlyString({ description: "Gong's unique numeric workspace id" }),
      name: readonlyString({ description: 'Workspace name' }),
      description: Type.Optional(readonlyNullableString({ description: 'Workspace description' })),
    },
    {
      $id: 'gong/workspaces',
      title: 'Workspaces',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Workspaces',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('name'),
    slugPath: dotPath('name'),
    basePath: [],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Library folders
// ---------------------------------------------------------------------------

export function buildGongLibraryFoldersJsonTableSpec(
  id: EntityId,
  workspaceId: string,
  workspaceName: string,
): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      id: readonlyString({ description: "Gong's unique numeric folder id" }),
      name: readonlyString({ description: 'Folder name' }),
      parentFolderId: Type.Optional(
        readonlyNullableString({
          description: 'Parent folder (null for top-level folders)',
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
            linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.LIBRARY_FOLDERS),
            linkedTableRemoteId: [GongEntityType.LIBRARY_FOLDERS, workspaceId],
            isSingleValued: true,
          },
        }),
      ),
      createdBy: Type.Optional(
        readonlyNullableString({
          description: 'The user who created the folder',
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
            linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.USERS),
            linkedTableRemoteId: [GongEntityType.USERS],
            isSingleValued: true,
          },
        }),
      ),
      updated: Type.Optional(readonlyNullableString({ format: 'date-time', description: 'Last update (ISO 8601)' })),
    },
    {
      $id: `gong/library-folders/${workspaceId}`,
      title: 'Library Folders',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Library Folders',
    schema,
    idPath: dotPath('id'),
    titlePath: dotPath('name'),
    slugPath: dotPath('name'),
    basePath: [workspaceName],
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Scorecards
// ---------------------------------------------------------------------------

export function buildGongScorecardsJsonTableSpec(
  id: EntityId,
  workspaceId: string,
  workspaceName: string,
): BaseJsonTableSpec {
  const schema = Type.Object(
    {
      scorecardId: readonlyString({ description: "Gong's unique numeric scorecard id" }),
      scorecardName: readonlyString({ description: 'Scorecard name' }),
      workspaceId: Type.Optional(
        readonlyNullableString({
          description: 'Workspace the scorecard belongs to',
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
            linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.WORKSPACES),
            linkedTableRemoteId: [GongEntityType.WORKSPACES],
            isSingleValued: true,
          },
        }),
      ),
      enabled: Type.Optional(readonlyNullableBoolean({ description: 'Whether the scorecard is enabled' })),
      updaterUserId: Type.Optional(
        readonlyNullableString({
          description: 'The user who last updated the scorecard',
          [X_SCRATCH_FOREIGN_KEY_OPTIONS]: {
            linkedTableId: gongForeignKeyLinkedTableId(GongEntityType.USERS),
            linkedTableRemoteId: [GongEntityType.USERS],
            isSingleValued: true,
          },
        }),
      ),
      created: Type.Optional(readonlyNullableString({ format: 'date-time', description: 'Created (ISO 8601)' })),
      updated: Type.Optional(readonlyNullableString({ format: 'date-time', description: 'Last update (ISO 8601)' })),
      questions: Type.Optional(
        Type.Array(Type.Unknown(), readonlyOptions({ description: 'The questions reviewers answer' })),
      ),
    },
    {
      $id: `gong/scorecards/${workspaceId}`,
      title: 'Scorecards',
    },
  );

  return {
    id,
    slug: id.wsId,
    name: 'Scorecards',
    schema,
    idPath: dotPath('scorecardId'),
    titlePath: dotPath('scorecardName'),
    slugPath: dotPath('scorecardName'),
    basePath: [workspaceName],
    generatedAt: new Date().toISOString(),
  };
}
