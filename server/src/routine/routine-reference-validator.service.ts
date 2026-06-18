import { Injectable } from '@nestjs/common';
import { WorkbookId } from '@spinner/shared-types';
import { DbService } from 'src/db/db.service';
import {
  ParsedRoutine,
  RoutineValidationContext,
  ValidationConnection,
  ValidationFolder,
  ValidationSync,
} from './routine.types';

/**
 * Validates that the data a routine references — each step's `folder` and `connection` —
 * actually exists in the workbook. This is the *semantic* pass that complements the pure,
 * structural {@link RoutineParserService}: the parser checks YAML shape (a `folder` merely
 * starts with "/" or "dfd_"), while this service resolves those references against the
 * workbook's real data folders and connections.
 *
 * It needs database access, so it deliberately lives outside the pure parser. It splits into
 * an async {@link loadContext} (two queries) and the pure {@link validateRoutineReferences}
 * function, so the context can be loaded once and reused across many routines (list/reload)
 * without per-step queries.
 */
@Injectable()
export class RoutineReferenceValidatorService {
  constructor(private readonly db: DbService) {}

  /** Loads every data folder + connection + sync for a workbook ONCE into lookup maps (three queries). */
  async loadContext(workbookId: WorkbookId): Promise<RoutineValidationContext> {
    const [dataFolders, connectorAccounts, syncs] = await Promise.all([
      this.db.client.dataFolder.findMany({
        where: { workbookId },
        select: { id: true, path: true, connectorAccountId: true },
      }),
      this.db.client.connectorAccount.findMany({
        where: { workbookId },
        select: { id: true, displayName: true },
      }),
      // eslint-disable-next-line no-restricted-syntax -- existence-only lookup (id + displayName); does not read sync mappings, so SyncService is unnecessary
      this.db.client.sync.findMany({
        where: { workbookId },
        select: { id: true, displayName: true },
      }),
    ]);

    const foldersByPath = new Map<string, ValidationFolder[]>();
    const foldersById = new Map<string, ValidationFolder>();
    for (const folder of dataFolders) {
      const validationFolder: ValidationFolder = {
        id: folder.id,
        // DataFolder.path is the only column stored WITH a leading slash — strip it once here so
        // the pure validator never has to re-derive the "/path" vs "path" variants.
        path: folder.path !== null ? normalizeFolderPath(folder.path) : '',
        connectorAccountId: folder.connectorAccountId,
      };
      foldersById.set(folder.id, validationFolder);
      // Only path-keyed folders are addressable by a POSIX path; a null-path folder can still be
      // referenced by its dfd_ id via foldersById above.
      if (folder.path !== null) {
        const foldersAtPath = foldersByPath.get(validationFolder.path);
        if (foldersAtPath) {
          foldersAtPath.push(validationFolder);
        } else {
          foldersByPath.set(validationFolder.path, [validationFolder]);
        }
      }
    }

    const connectionsByName = new Map<string, ValidationConnection>();
    const connectionsById = new Map<string, ValidationConnection>();
    for (const account of connectorAccounts) {
      const connection: ValidationConnection = { id: account.id, displayName: account.displayName };
      connectionsById.set(account.id, connection);
      connectionsByName.set(account.displayName.toLowerCase(), connection);
    }

    const syncsById = new Map<string, ValidationSync>();
    for (const sync of syncs) {
      syncsById.set(sync.id, { id: sync.id, displayName: sync.displayName });
    }

    return { foldersByPath, foldersById, connectionsByName, connectionsById, syncsById };
  }

  /** Convenience: load the workbook's validation context, then validate a single routine. */
  async validateRoutine(workbookId: WorkbookId, routine: ParsedRoutine): Promise<string[]> {
    const context = await this.loadContext(workbookId);
    return validateRoutineReferences(routine, context);
  }
}

/** Drops a leading slash so routine paths ("/blog/posts") and stored DataFolder paths key the same. */
function normalizeFolderPath(path: string): string {
  return path.replace(/^\/+/, '');
}

/**
 * PURE — given a parsed routine and a workbook's {@link RoutineValidationContext}, returns the list
 * of human-readable semantic errors (empty = valid). Resolves the `connection` first because it
 * scopes an otherwise-ambiguous `folder` path. Collects ALL errors rather than stopping at the
 * first, so the editor can surface every problem in one save. Message format mirrors the structural
 * validator's `formatRoutineValidationError`: `steps.<i>.<field>: <message>`.
 */
export function validateRoutineReferences(routine: ParsedRoutine, context: RoutineValidationContext): string[] {
  const errors: string[] = [];

  routine.steps.forEach((step, stepIndex) => {
    const stepPrefix = `steps.${stepIndex}`;

    // A sync step is addressed solely by its SyncId — resolve that and skip folder/connection
    // (the structural validator already forbids folder/connection on sync steps).
    if (step.sync !== null) {
      if (!resolveSyncInContext(step.sync, context)) {
        errors.push(`${stepPrefix}.sync: sync "${step.sync}" not found in this workbook`);
      }
      return;
    }

    // A null `connection` means "all connections" and a null `folder` means "all folders" — both
    // are valid wildcards, so there is nothing to resolve.
    let resolvedConnection: ValidationConnection | null = null;
    if (step.connection !== null) {
      resolvedConnection = resolveConnectionInContext(step.connection, context);
      if (!resolvedConnection) {
        errors.push(`${stepPrefix}.connection: connection "${step.connection}" not found in this workbook`);
      }
    }

    if (step.folder !== null) {
      const folderError = validateStepFolder(step.folder, step.connection, resolvedConnection, context, stepPrefix);
      if (folderError) {
        errors.push(folderError);
      }
    }
  });

  return errors;
}

/**
 * Resolves a step's `connection` (a "coa_..." id or a connection name) against the context.
 * Exported so the executor resolves a step's target the same way the validator checks it.
 */
export function resolveConnectionInContext(
  connection: string,
  context: RoutineValidationContext,
): ValidationConnection | null {
  if (connection.startsWith('coa_')) {
    return context.connectionsById.get(connection) ?? null;
  }
  return context.connectionsByName.get(connection.toLowerCase()) ?? null;
}

/** Resolves a step's `sync` (a "sync_..." id) against the context. */
export function resolveSyncInContext(syncId: string, context: RoutineValidationContext): ValidationSync | null {
  return context.syncsById.get(syncId) ?? null;
}

/**
 * Resolves a step's `folder` to the matching folders, scoped to a resolved connection when given.
 * A `dfd_` id resolves to that single folder; a POSIX path resolves to every folder at that path
 * (possibly several across connections). Returns [] when nothing matches. The executor uses this to
 * turn a step's `folder`/`connection` into concrete DataFolders; the validator's `validateStepFolder`
 * remains the authority for surfacing *why* a folder doesn't resolve.
 */
export function resolveFoldersInContext(
  folder: string,
  resolvedConnection: ValidationConnection | null,
  context: RoutineValidationContext,
): ValidationFolder[] {
  if (folder.startsWith('dfd_')) {
    const folderById = context.foldersById.get(folder);
    if (!folderById) {
      return [];
    }
    if (resolvedConnection && folderById.connectorAccountId !== resolvedConnection.id) {
      return [];
    }
    return [folderById];
  }

  const foldersAtPath = context.foldersByPath.get(normalizeFolderPath(folder)) ?? [];
  if (!resolvedConnection) {
    return foldersAtPath;
  }
  return foldersAtPath.filter((candidate) => candidate.connectorAccountId === resolvedConnection.id);
}

/**
 * Validates a step's `folder` (a "dfd_..." id or a POSIX path) against the context, using the
 * already-resolved connection to disambiguate a path that exists in multiple connections and to
 * flag a folder/connection mismatch. Returns an error message, or null when the folder resolves.
 */
function validateStepFolder(
  folder: string,
  connectionRaw: string | null,
  resolvedConnection: ValidationConnection | null,
  context: RoutineValidationContext,
  stepPrefix: string,
): string | null {
  if (folder.startsWith('dfd_')) {
    const folderById = context.foldersById.get(folder);
    if (!folderById) {
      return `${stepPrefix}.folder: folder "${folder}" not found in this workbook`;
    }
    if (resolvedConnection && folderById.connectorAccountId !== resolvedConnection.id) {
      return `${stepPrefix}.folder: folder "${folder}" does not belong to connection "${connectionRaw}"`;
    }
    return null;
  }

  const normalizedPath = normalizeFolderPath(folder);
  const foldersAtPath = context.foldersByPath.get(normalizedPath) ?? [];

  if (foldersAtPath.length === 0) {
    return `${stepPrefix}.folder: folder "${folder}" not found in this workbook`;
  }

  if (foldersAtPath.length === 1) {
    const onlyFolder = foldersAtPath[0];
    if (resolvedConnection && onlyFolder.connectorAccountId !== resolvedConnection.id) {
      return `${stepPrefix}.folder: folder "${folder}" does not belong to connection "${connectionRaw}"`;
    }
    return null;
  }

  // The path matches multiple folders across different connections — ambiguous.
  if (!resolvedConnection) {
    // A connection was given but did not resolve: the connection-not-found error already covers
    // this step, so don't pile on an ambiguity error too. Only flag ambiguity when no connection
    // was supplied at all.
    if (connectionRaw !== null) {
      return null;
    }
    return `${stepPrefix}.folder: folder "${folder}" is ambiguous — it exists in multiple connections; add a "connection:" to disambiguate`;
  }

  const foldersScopedToConnection = foldersAtPath.filter(
    (candidate) => candidate.connectorAccountId === resolvedConnection.id,
  );
  if (foldersScopedToConnection.length === 0) {
    return `${stepPrefix}.folder: folder "${folder}" not found in connection "${connectionRaw}"`;
  }
  return null;
}
