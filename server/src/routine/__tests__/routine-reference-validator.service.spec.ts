import { RoutineAction, RoutineStep, WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import { RoutineReferenceValidatorService, validateRoutineReferences } from '../routine-reference-validator.service';
import {
  ParsedRoutine,
  RoutineValidationContext,
  ValidationConnection,
  ValidationFolder,
  ValidationSync,
} from '../routine.types';

const WORKBOOK_ID = 'wkb_test1234' as WorkbookId;

/** Builds a validation context from already-normalized (no-leading-slash) folders + connections + syncs. */
function buildContext(
  folders: ValidationFolder[],
  connections: ValidationConnection[],
  syncs: ValidationSync[] = [],
): RoutineValidationContext {
  const foldersByPath = new Map<string, ValidationFolder[]>();
  const foldersById = new Map<string, ValidationFolder>();
  for (const folder of folders) {
    foldersById.set(folder.id, folder);
    const foldersAtPath = foldersByPath.get(folder.path);
    if (foldersAtPath) {
      foldersAtPath.push(folder);
    } else {
      foldersByPath.set(folder.path, [folder]);
    }
  }
  const connectionsByName = new Map<string, ValidationConnection>();
  const connectionsById = new Map<string, ValidationConnection>();
  for (const connection of connections) {
    connectionsById.set(connection.id, connection);
    connectionsByName.set(connection.displayName.toLowerCase(), connection);
  }
  const syncsById = new Map<string, ValidationSync>();
  for (const sync of syncs) {
    syncsById.set(sync.id, sync);
  }
  return { foldersByPath, foldersById, connectionsByName, connectionsById, syncsById };
}

/** Builds a ParsedRoutine from a list of partial steps (action defaults to pull). */
function routineWithSteps(steps: Partial<RoutineStep>[]): ParsedRoutine {
  return {
    name: 'Test Routine',
    schedule: null,
    comment: null,
    steps: steps.map((step) => ({
      action: step.action ?? RoutineAction.PULL,
      name: step.name ?? null,
      folder: step.folder ?? null,
      connection: step.connection ?? null,
      sync: step.sync ?? null,
      comment: step.comment ?? null,
      timeout: step.timeout ?? null,
      options: step.options ?? null,
    })),
  };
}

describe('validateRoutineReferences', () => {
  it('returns no errors when a folder path resolves to a single folder', () => {
    const context = buildContext([{ id: 'dfd_1', path: 'blog/posts', connectorAccountId: 'coa_1' }], []);
    const routine = routineWithSteps([{ action: RoutineAction.PULL, folder: '/blog/posts' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([]);
  });

  it('returns no errors when a folder resolves by its dfd_ id', () => {
    const context = buildContext([{ id: 'dfd_1', path: 'blog/posts', connectorAccountId: 'coa_1' }], []);
    const routine = routineWithSteps([{ folder: 'dfd_1' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([]);
  });

  it('resolves a connection by name and by coa_ id when the folder belongs to it', () => {
    const context = buildContext(
      [{ id: 'dfd_1', path: 'blog/posts', connectorAccountId: 'coa_1' }],
      [{ id: 'coa_1', displayName: 'Airtable Prod' }],
    );

    const byName = routineWithSteps([{ folder: '/blog/posts', connection: 'Airtable Prod' }]);
    const byId = routineWithSteps([{ folder: 'dfd_1', connection: 'coa_1' }]);

    expect(validateRoutineReferences(byName, context)).toEqual([]);
    expect(validateRoutineReferences(byId, context)).toEqual([]);
  });

  it('matches a connection name case-insensitively', () => {
    const context = buildContext([], [{ id: 'coa_1', displayName: 'Airtable Prod' }]);
    const routine = routineWithSteps([{ connection: 'airtable prod' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([]);
  });

  it('flags a folder path that does not exist', () => {
    const context = buildContext([], []);
    const routine = routineWithSteps([{ folder: '/path/to/folder' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([
      'steps.0.folder: folder "/path/to/folder" not found in this workbook',
    ]);
  });

  it('flags a dfd_ id that does not exist', () => {
    const context = buildContext([{ id: 'dfd_1', path: 'blog', connectorAccountId: 'coa_1' }], []);
    const routine = routineWithSteps([{ folder: 'dfd_missing' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([
      'steps.0.folder: folder "dfd_missing" not found in this workbook',
    ]);
  });

  it('flags an ambiguous folder path when no connection disambiguates it', () => {
    const context = buildContext(
      [
        { id: 'dfd_1', path: 'contacts', connectorAccountId: 'coa_1' },
        { id: 'dfd_2', path: 'contacts', connectorAccountId: 'coa_2' },
      ],
      [],
    );
    const routine = routineWithSteps([{ folder: '/contacts' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([
      'steps.0.folder: folder "/contacts" is ambiguous — it exists in multiple connections; add a "connection:" to disambiguate',
    ]);
  });

  it('resolves an ambiguous folder path via a matching connection', () => {
    const context = buildContext(
      [
        { id: 'dfd_1', path: 'contacts', connectorAccountId: 'coa_1' },
        { id: 'dfd_2', path: 'contacts', connectorAccountId: 'coa_2' },
      ],
      [
        { id: 'coa_1', displayName: 'CRM' },
        { id: 'coa_2', displayName: 'Generic' },
      ],
    );
    const routine = routineWithSteps([{ folder: '/contacts', connection: 'coa_1' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([]);
  });

  it('flags an ambiguous folder path whose connection matches no folder at that path', () => {
    const context = buildContext(
      [
        { id: 'dfd_1', path: 'contacts', connectorAccountId: 'coa_1' },
        { id: 'dfd_2', path: 'contacts', connectorAccountId: 'coa_2' },
      ],
      [
        { id: 'coa_1', displayName: 'CRM' },
        { id: 'coa_3', displayName: 'Other' },
      ],
    );
    const routine = routineWithSteps([{ folder: '/contacts', connection: 'coa_3' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([
      'steps.0.folder: folder "/contacts" not found in connection "coa_3"',
    ]);
  });

  it('flags a connection name that does not exist', () => {
    const context = buildContext([], []);
    const routine = routineWithSteps([{ connection: 'Nonexistent' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([
      'steps.0.connection: connection "Nonexistent" not found in this workbook',
    ]);
  });

  it('flags a coa_ id connection that does not exist', () => {
    const context = buildContext([], []);
    const routine = routineWithSteps([{ connection: 'coa_missing' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([
      'steps.0.connection: connection "coa_missing" not found in this workbook',
    ]);
  });

  it('flags a folder that does not belong to the given connection (by path)', () => {
    const context = buildContext(
      [{ id: 'dfd_1', path: 'blog', connectorAccountId: 'coa_1' }],
      [
        { id: 'coa_1', displayName: 'CRM' },
        { id: 'coa_2', displayName: 'Other' },
      ],
    );
    const routine = routineWithSteps([{ folder: '/blog', connection: 'coa_2' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([
      'steps.0.folder: folder "/blog" does not belong to connection "coa_2"',
    ]);
  });

  it('flags a folder that does not belong to the given connection (by dfd_ id)', () => {
    const context = buildContext(
      [{ id: 'dfd_1', path: 'blog', connectorAccountId: 'coa_1' }],
      [
        { id: 'coa_1', displayName: 'CRM' },
        { id: 'coa_2', displayName: 'Other' },
      ],
    );
    const routine = routineWithSteps([{ folder: 'dfd_1', connection: 'coa_2' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([
      'steps.0.folder: folder "dfd_1" does not belong to connection "coa_2"',
    ]);
  });

  it('reports only the connection error (not ambiguity) when the connection is unresolved', () => {
    const context = buildContext(
      [
        { id: 'dfd_1', path: 'contacts', connectorAccountId: 'coa_1' },
        { id: 'dfd_2', path: 'contacts', connectorAccountId: 'coa_2' },
      ],
      [],
    );
    const routine = routineWithSteps([{ folder: '/contacts', connection: 'ghost' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([
      'steps.0.connection: connection "ghost" not found in this workbook',
    ]);
  });

  it('skips steps with no folder and no connection (both wildcards)', () => {
    const context = buildContext([], []);
    const routine = routineWithSteps([{ action: RoutineAction.PUBLISH }]);

    expect(validateRoutineReferences(routine, context)).toEqual([]);
  });

  it('collects errors across multiple steps with the correct indices', () => {
    const context = buildContext([], []);
    const routine = routineWithSteps([{ folder: '/missing-a' }, { connection: 'nope' }, { folder: 'dfd_x' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([
      'steps.0.folder: folder "/missing-a" not found in this workbook',
      'steps.1.connection: connection "nope" not found in this workbook',
      'steps.2.folder: folder "dfd_x" not found in this workbook',
    ]);
  });

  it('resolves a sync step by its syn_ id', () => {
    const context = buildContext([], [], [{ id: 'syn_1', displayName: 'Blog → Webflow' }]);
    const routine = routineWithSteps([{ action: RoutineAction.SYNC, sync: 'syn_1' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([]);
  });

  it('flags a sync step whose syn_ id does not exist', () => {
    const context = buildContext([], [], [{ id: 'syn_1', displayName: 'Blog → Webflow' }]);
    const routine = routineWithSteps([{ action: RoutineAction.SYNC, sync: 'syn_missing' }]);

    expect(validateRoutineReferences(routine, context)).toEqual([
      'steps.0.sync: sync "syn_missing" not found in this workbook',
    ]);
  });
});

describe('RoutineReferenceValidatorService.loadContext', () => {
  it('builds normalized lookup maps from two scoped queries', async () => {
    const dataFolderFindMany = jest.fn().mockResolvedValue([
      { id: 'dfd_1', path: '/Blog/Posts', connectorAccountId: 'coa_1' },
      { id: 'dfd_2', path: null, connectorAccountId: null },
    ]);
    const connectorAccountFindMany = jest.fn().mockResolvedValue([{ id: 'coa_1', displayName: 'Airtable Prod' }]);
    const syncFindMany = jest.fn().mockResolvedValue([{ id: 'syn_1', displayName: 'Blog → Webflow' }]);
    const db = {
      client: {
        dataFolder: { findMany: dataFolderFindMany },
        connectorAccount: { findMany: connectorAccountFindMany },
        sync: { findMany: syncFindMany },
      },
    } as unknown as DbService;
    const service = new RoutineReferenceValidatorService(db);

    const context = await service.loadContext(WORKBOOK_ID);

    expect(dataFolderFindMany).toHaveBeenCalledWith({
      where: { workbookId: WORKBOOK_ID },
      select: { id: true, path: true, connectorAccountId: true },
    });
    expect(connectorAccountFindMany).toHaveBeenCalledWith({
      where: { workbookId: WORKBOOK_ID },
      select: { id: true, displayName: true },
    });
    expect(syncFindMany).toHaveBeenCalledWith({
      where: { workbookId: WORKBOOK_ID },
      select: { id: true, displayName: true },
    });
    expect(context.syncsById.get('syn_1')).toEqual({ id: 'syn_1', displayName: 'Blog → Webflow' });

    // Path key is normalized (leading slash dropped); a null-path folder is excluded from foldersByPath...
    expect(context.foldersByPath.get('Blog/Posts')).toEqual([
      { id: 'dfd_1', path: 'Blog/Posts', connectorAccountId: 'coa_1' },
    ]);
    expect(context.foldersByPath.has('')).toBe(false);
    // ...but is still addressable by its dfd_ id.
    expect(context.foldersById.get('dfd_2')).toEqual({ id: 'dfd_2', path: '', connectorAccountId: null });

    // Connection name key is lowercased; id key is verbatim.
    expect(context.connectionsByName.get('airtable prod')?.id).toBe('coa_1');
    expect(context.connectionsById.get('coa_1')?.displayName).toBe('Airtable Prod');
  });
});
