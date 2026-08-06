import { TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { X_SCRATCH_FOREIGN_KEY_OPTIONS, X_SCRATCH_READONLY } from '@spinner/shared-types';
import {
  buildGongCallsJsonTableSpec,
  buildGongLibraryFoldersJsonTableSpec,
  buildGongUsersJsonTableSpec,
  buildGongWorkspacesJsonTableSpec,
  gongTableWsId,
} from '../gong-json-schema';
import { GongEntityType } from '../gong-types';

const WORKSPACE_ID = '1299375510811165803';
const WORKSPACE_NAME = 'Initial workspace';

/** A verbatim user record as the live API returned it (2026-08-05, dev instance). */
const LIVE_USER_RECORD = {
  id: '6434845837860324905',
  emailAddress: 'ryder@whalesync.com',
  created: '2026-08-05T17:36:10.507-07:00',
  active: true,
  emailAliases: [],
  trustedEmailAddress: null,
  firstName: 'Ryder',
  lastName: 'Ziola',
  title: null,
  phoneNumber: null,
  extension: null,
  personalMeetingUrls: [],
  settings: {
    webConferencesRecorded: false,
    preventWebConferenceRecording: false,
    telephonyCallsImported: false,
    emailsImported: false,
    preventEmailImport: false,
    nonRecordedMeetingsImported: false,
    gongConnectEnabled: false,
  },
  managerId: null,
  meetingConsentPageUrl: null,
  conferencingProviders: null,
  spokenLanguages: [],
};

/** A verbatim library folder record as the live API returned it. */
const LIVE_FOLDER_RECORD = {
  id: '348477734967792764',
  name: 'Public Folders',
  parentFolderId: null,
  createdBy: null,
  updated: '2026-08-05T17:36:01.213633-07:00',
};

/** A minimal extensive call record (metadata only — analysis not yet computed). */
const MINIMAL_CALL_RECORD = {
  metaData: {
    id: '7782342274025937895',
    url: 'https://us02-125032.app.gong.io/call?id=7782342274025937895',
    title: 'Discovery call',
    scheduled: null,
    started: '2026-08-03T10:00:00-07:00',
    duration: 460,
    primaryUserId: '6434845837860324905',
    direction: 'Outbound',
    system: 'Generic',
    scope: 'External',
    media: 'Audio',
    language: 'eng',
    workspaceId: WORKSPACE_ID,
    sdrDisposition: 'Demo scheduled',
    clientUniqueId: 'scratch-seed-001',
    customData: null,
    purpose: 'Discovery',
    meetingUrl: null,
    isPrivate: false,
    calendarEventId: null,
  },
  parties: [{ id: 'p1', emailAddress: 'ryder@whalesync.com', name: 'Ryder Ziola', userId: '6434845837860324905' }],
};

function walkSchemaLeaves(schema: TSchema, visit: (schema: TSchema, path: string) => void, path = ''): void {
  visit(schema, path);
  const properties = (schema as TSchema & { properties?: Record<string, TSchema> }).properties;
  if (properties) {
    for (const [key, child] of Object.entries(properties)) {
      walkSchemaLeaves(child, visit, path ? `${path}.${key}` : key);
    }
  }
  const anyOf = (schema as TSchema & { anyOf?: TSchema[] }).anyOf;
  if (anyOf) {
    for (const variant of anyOf) walkSchemaLeaves(variant, visit, path);
  }
}

describe('gongTableWsId', () => {
  it('appends the workspace id only for workspace-scoped entities', () => {
    expect(gongTableWsId(GongEntityType.USERS)).toBe('users');
    expect(gongTableWsId(GongEntityType.WORKSPACES)).toBe('workspaces');
    expect(gongTableWsId(GongEntityType.CALLS, WORKSPACE_ID)).toBe(`calls_${WORKSPACE_ID}`);
    expect(gongTableWsId(GongEntityType.LIBRARY_FOLDERS, WORKSPACE_ID)).toBe(`library_folders_${WORKSPACE_ID}`);
  });
});

describe('Gong JSON schemas', () => {
  it('verbatim live user record conforms to the Users schema', () => {
    const spec = buildGongUsersJsonTableSpec({ wsId: 'users', remoteId: ['users'] });
    const validation_errors = [...Value.Errors(spec.schema, LIVE_USER_RECORD)];
    expect(validation_errors).toEqual([]);
  });

  it('verbatim live folder record conforms to the Library Folders schema', () => {
    const spec = buildGongLibraryFoldersJsonTableSpec(
      {
        wsId: gongTableWsId(GongEntityType.LIBRARY_FOLDERS, WORKSPACE_ID),
        remoteId: ['library-folders', WORKSPACE_ID],
      },
      WORKSPACE_ID,
      WORKSPACE_NAME,
    );
    expect([...Value.Errors(spec.schema, LIVE_FOLDER_RECORD)]).toEqual([]);
  });

  it('a metadata-only call record (analysis pending) conforms to the Calls schema', () => {
    const spec = buildGongCallsJsonTableSpec(
      { wsId: gongTableWsId(GongEntityType.CALLS, WORKSPACE_ID), remoteId: ['calls', WORKSPACE_ID] },
      WORKSPACE_ID,
      WORKSPACE_NAME,
    );
    expect([...Value.Errors(spec.schema, MINIMAL_CALL_RECORD)]).toEqual([]);
  });

  it('marks every field read-only (Gong has no write surface)', () => {
    const specs = [
      buildGongUsersJsonTableSpec({ wsId: 'users', remoteId: ['users'] }),
      buildGongWorkspacesJsonTableSpec({ wsId: 'workspaces', remoteId: ['workspaces'] }),
      buildGongCallsJsonTableSpec(
        { wsId: gongTableWsId(GongEntityType.CALLS, WORKSPACE_ID), remoteId: ['calls', WORKSPACE_ID] },
        WORKSPACE_ID,
        WORKSPACE_NAME,
      ),
    ];
    for (const spec of specs) {
      const properties = (spec.schema as TSchema & { properties: Record<string, TSchema> }).properties;
      for (const [field_name, field_schema] of Object.entries(properties)) {
        const readonly_flag_anywhere_in_field: boolean[] = [];
        walkSchemaLeaves(field_schema, (node) => {
          readonly_flag_anywhere_in_field.push((node as Record<string, unknown>)[X_SCRATCH_READONLY] === true);
        });
        expect({
          field: `${spec.name}.${field_name}`,
          readonly: readonly_flag_anywhere_in_field.some(Boolean),
        }).toEqual({ field: `${spec.name}.${field_name}`, readonly: true });
      }
    }
  });

  it('declares foreign keys pointing at the right tables', () => {
    const calls_spec = buildGongCallsJsonTableSpec(
      { wsId: gongTableWsId(GongEntityType.CALLS, WORKSPACE_ID), remoteId: ['calls', WORKSPACE_ID] },
      WORKSPACE_ID,
      WORKSPACE_NAME,
    );
    const fk_annotations_by_path: Record<string, { linkedTableId: string }> = {};
    walkSchemaLeaves(calls_spec.schema, (node, path) => {
      const fk = (node as Record<string, unknown>)[X_SCRATCH_FOREIGN_KEY_OPTIONS] as
        | { linkedTableId: string }
        | undefined;
      if (fk) fk_annotations_by_path[path] = fk;
    });
    expect(fk_annotations_by_path['metaData.primaryUserId']?.linkedTableId).toBe('users');
    expect(fk_annotations_by_path['metaData.workspaceId']?.linkedTableId).toBe('workspaces');

    const folders_spec = buildGongLibraryFoldersJsonTableSpec(
      {
        wsId: gongTableWsId(GongEntityType.LIBRARY_FOLDERS, WORKSPACE_ID),
        remoteId: ['library-folders', WORKSPACE_ID],
      },
      WORKSPACE_ID,
      WORKSPACE_NAME,
    );
    const folders_fk_by_path: Record<string, { linkedTableId: string; linkedTableRemoteId?: string[] }> = {};
    walkSchemaLeaves(folders_spec.schema, (node, path) => {
      const fk = (node as Record<string, unknown>)[X_SCRATCH_FOREIGN_KEY_OPTIONS] as
        | { linkedTableId: string; linkedTableRemoteId?: string[] }
        | undefined;
      if (fk) folders_fk_by_path[path] = fk;
    });
    // Self-FK token must be the bare remoteId segment (never the sanitized
    // wsId — the plan generator matches candidate tokens of DataFolder.tableId),
    // with the exact workspace-scoped target in linkedTableRemoteId.
    expect(folders_fk_by_path['parentFolderId']?.linkedTableId).toBe('library-folders');
    expect(folders_fk_by_path['parentFolderId']?.linkedTableRemoteId).toEqual(['library-folders', WORKSPACE_ID]);

    const users_spec = buildGongUsersJsonTableSpec({ wsId: 'users', remoteId: ['users'] });
    const users_fk_by_path: Record<string, { linkedTableId: string }> = {};
    walkSchemaLeaves(users_spec.schema, (node, path) => {
      const fk = (node as Record<string, unknown>)[X_SCRATCH_FOREIGN_KEY_OPTIONS] as
        | { linkedTableId: string }
        | undefined;
      if (fk) users_fk_by_path[path] = fk;
    });
    expect(users_fk_by_path['managerId']?.linkedTableId).toBe('users');
  });
});
