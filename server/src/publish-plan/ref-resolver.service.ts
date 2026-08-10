import { Injectable } from '@nestjs/common';
import { DbService } from 'src/db/db.service';
import { ParsedContent } from 'src/utils/objects';
import {
  sanitizeConnectionFolderName,
  sanitizeLegacyConnectionFolderName,
} from 'src/workbook/connector-folder-path.util';
import { fileIndexLookupKey, FileIndexService } from './file-index.service';
import { parsePath } from './utils';

/**
 * A pseudo-ref (`@/…`), already stripped of the `@/` marker and translated from
 * the user-facing workspace-absolute form into the internal, connection-scoped
 * form the FileIndex is keyed by. See {@link RefResolverService.translatePseudoRef}.
 */
interface TranslatedPseudoRef {
  /**
   * The connection(s) the ref's leading connection folder segment names. Exactly one in every
   * normal workspace; more only when two connections in the workbook sanitize to the same
   * folder name, which the resolver settles by probing the FileIndex per candidate (see
   * {@link RefResolverService.resolveAmbiguousRefs}).
   *
   * **Never empty.** A segment that names no connection is not a resolvable ref at all, so
   * {@link RefResolverService.translatePseudoRef} throws rather than returning one.
   */
  candidateConnectorAccountIds: string[];
  /** Connection-relative folder path (no connection segment, no leading slash). */
  folderPath: string;
  filename: string;
}

/** Thrown when a `@/…` value is not a resolvable workspace-absolute pseudo-ref. */
export class MalformedPseudoRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedPseudoRefError';
  }
}

/**
 * A workbook's connection folders, indexed the three ways the resolver needs them: to map a
 * ref's leading segment to its connection(s), to name a connection in an error, and to tell
 * the user which folder names their workspace actually has.
 */
interface ConnectionFolderIndex {
  /** Folder name → every connection claiming it (see {@link TranslatedPseudoRef}). */
  folderNameToAccountIds: Map<string, string[]>;
  /** connectorAccountId → the connection's display name, for error messages. */
  displayNameByAccountId: Map<string, string>;
  /** The connection folder names as they appear at the top of the workspace tree. */
  primaryFolderNames: string[];
}

/** Used when a batch carries no pseudo-refs at all, so the map query is skipped entirely. */
const EMPTY_CONNECTION_FOLDER_INDEX: ConnectionFolderIndex = {
  folderNameToAccountIds: new Map(),
  displayNameByAccountId: new Map(),
  primaryFolderNames: [],
};

@Injectable()
export class RefResolverService {
  constructor(
    private readonly fileIndexService: FileIndexService,
    private readonly db: DbService,
  ) {}

  /**
   * Build the map from a workbook's connection folder names (the first segment of
   * a workspace-absolute pseudo-ref) to the `connectorAccountId`s that claim them.
   *
   * A pseudo-ref is user-facing and lives in the one-tree model, where each
   * connection is a top-level folder named after its (sanitized) display name.
   * Internally each connection is its own git repo keyed connection-relative, so
   * to resolve a ref we must map its leading segment back to a connection. We
   * register BOTH naming schemes a workspace may have used — the bare sanitized
   * display name and the legacy `"<SERVICE> - <displayName>"` form — so refs
   * authored under either folder layout resolve. (That legacy *folder naming* is a
   * separate axis from the legacy *ref format* this resolver no longer accepts:
   * those folders genuinely exist on disk, so `@/AIRTABLE - Airtable/…` is canonical.)
   *
   * A name claimed by two connections maps to BOTH — it is not dropped. Dropping it
   * used to be safe only because the legacy fallback caught the ref afterwards; with
   * that gone, dropping would make two identically-named connections unpublishable.
   * Such a name is settled by probing the FileIndex per candidate instead
   * (see {@link resolveAmbiguousRefs}).
   */
  private async buildConnectionFolderToAccountIdsMap(workbookId: string): Promise<ConnectionFolderIndex> {
    const connectorAccounts = await this.db.client.connectorAccount.findMany({
      where: { workbookId },
      select: { id: true, service: true, displayName: true },
    });

    const folderNameToAccountIds = new Map<string, string[]>();
    const register = (folderName: string, connectorAccountId: string) => {
      if (folderName.length === 0) return;
      const claimants = folderNameToAccountIds.get(folderName);
      if (claimants === undefined) {
        folderNameToAccountIds.set(folderName, [connectorAccountId]);
      } else if (!claimants.includes(connectorAccountId)) {
        claimants.push(connectorAccountId);
      }
    };

    // The names a user actually sees at the top of their workspace tree — quoted back at
    // them when a ref names something that isn't one of them. Deduped, since two connections
    // can sanitize onto the same folder name and listing it twice reads like a bug.
    const primaryFolderNames = new Set<string>();
    for (const account of connectorAccounts) {
      const primaryFolderName = sanitizeConnectionFolderName(account.displayName);
      if (primaryFolderName.length > 0) primaryFolderNames.add(primaryFolderName);
      register(primaryFolderName, account.id);
      register(sanitizeLegacyConnectionFolderName(account.service, account.displayName), account.id);
    }
    return {
      folderNameToAccountIds,
      displayNameByAccountId: new Map(connectorAccounts.map((account) => [account.id, account.displayName])),
      primaryFolderNames: [...primaryFolderNames],
    };
  }

  /**
   * Translate one `@/…` pseudo-ref string into its connection-scoped lookup key.
   *
   * A pseudo-ref MUST be workspace-absolute: it leads with a connection folder segment
   * (`@/HubSpot/Contacts/x.json`), which we peel off and map back to a connection. That is the
   * only accepted reading. A ref whose first segment names no connection throws a diagnostic
   * error naming the workspace's actual connection folders, rather than being reinterpreted
   * against some other connection and quietly resolving somewhere plausible.
   *
   * @throws {MalformedPseudoRefError} when the ref is not workspace-absolute.
   */
  private translatePseudoRef(pseudoRefString: string, connectionFolders: ConnectionFolderIndex): TranslatedPseudoRef {
    const targetPath = pseudoRefString.substring(2); // strip the '@/' marker
    const firstSlashIndex = targetPath.indexOf('/');
    const firstSegment = firstSlashIndex === -1 ? targetPath : targetPath.substring(0, firstSlashIndex);
    const candidateConnectorAccountIds = connectionFolders.folderNameToAccountIds.get(firstSegment);

    if (firstSlashIndex === -1 || candidateConnectorAccountIds === undefined) {
      const expected =
        connectionFolders.primaryFolderNames.length > 0
          ? `expected one of: ${connectionFolders.primaryFolderNames.join(', ')}`
          : 'this workspace has no connection folders';
      throw new MalformedPseudoRefError(
        `Pseudo-ref "${pseudoRefString}" is not workspace-absolute: "${firstSegment}" is not a connection ` +
          `folder in this workspace (${expected}). Use "@/<connection>/<folder>/<file>.json".`,
      );
    }

    const { folderPath, filename } = parsePath(targetPath.substring(firstSlashIndex + 1));
    return { candidateConnectorAccountIds, folderPath, filename };
  }

  /** Collect the unique `@/…` pseudo-ref strings in an object (not `@asset/…`). */
  private collectPseudoRefStrings(content: unknown, out: Set<string>): void {
    if (typeof content === 'string' && content.startsWith('@/')) {
      out.add(content);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        this.collectPseudoRefStrings(item, out);
      }
    } else if (typeof content === 'object' && content !== null) {
      for (const value of Object.values(content)) {
        this.collectPseudoRefStrings(value, out);
      }
    }
  }

  /**
   * Resolve each unique `@/…` ref string to a record id.
   *
   * One bulk FileIndex lookup covers every ref whose connection folder segment names exactly
   * one connection — i.e. all of them, in every workspace that doesn't have two connections
   * sharing a folder name. Those rare ambiguous refs are settled afterwards with a strict
   * per-candidate probe. Unresolvable refs are absent from the returned map (the caller
   * throws with context); a MALFORMED ref never gets this far — `translatePseudoRef` throws.
   */
  private async resolvePseudoRefStrings(
    workbookId: string,
    refStrings: string[],
    connectionFolders: ConnectionFolderIndex,
  ): Promise<Map<string, string>> {
    const refStringToRecordId = new Map<string, string>();
    if (refStrings.length === 0) return refStringToRecordId;

    const unambiguousByRefString = new Map<string, TranslatedPseudoRef>();
    const ambiguousByRefString = new Map<string, TranslatedPseudoRef>();
    for (const refString of refStrings) {
      const translated = this.translatePseudoRef(refString, connectionFolders);
      if (translated.candidateConnectorAccountIds.length === 1) {
        unambiguousByRefString.set(refString, translated);
      } else {
        ambiguousByRefString.set(refString, translated);
      }
    }

    if (unambiguousByRefString.size > 0) {
      const recordIdByLookupKey = await this.fileIndexService.getRecordIds(
        workbookId,
        dedupeRefs([...unambiguousByRefString.values()]),
      );
      for (const [refString, translated] of unambiguousByRefString) {
        const recordId = recordIdByLookupKey.get(fileIndexLookupKey(asFileIndexLookup(translated)));
        if (recordId) refStringToRecordId.set(refString, recordId);
      }
    }

    if (ambiguousByRefString.size > 0) {
      await this.resolveAmbiguousRefs(workbookId, ambiguousByRefString, connectionFolders, refStringToRecordId);
    }

    return refStringToRecordId;
  }

  /**
   * Settle refs whose connection folder segment is claimed by more than one connection.
   *
   * The bulk lookup can't do this: a ref with several candidate connections has no single
   * lookup key to ask under. Instead each candidate is probed on its own — `getRecordId` is a
   * strict per-connection match (DEV-11242), so a candidate that doesn't hold the file answers
   * `null` rather than another connection's row:
   *
   * - exactly one candidate holds the file → that's the ref's target;
   * - none do → leave it unresolved, so the caller reports it like any missing target;
   * - two or more do → genuinely ambiguous, so throw and NAME both connections rather than
   *   pick one. Linking the wrong record is worse than failing to link.
   *
   * Rare enough (it needs two connections whose display names sanitize identically) to be
   * worth a query per candidate.
   */
  private async resolveAmbiguousRefs(
    workbookId: string,
    ambiguousByRefString: Map<string, TranslatedPseudoRef>,
    connectionFolders: ConnectionFolderIndex,
    refStringToRecordId: Map<string, string>,
  ): Promise<void> {
    for (const [refString, translated] of ambiguousByRefString) {
      const hits: { connectorAccountId: string; recordId: string }[] = [];
      for (const connectorAccountId of translated.candidateConnectorAccountIds) {
        const recordId = await this.fileIndexService.getRecordId(
          workbookId,
          translated.folderPath,
          translated.filename,
          connectorAccountId,
        );
        if (recordId !== null) hits.push({ connectorAccountId, recordId });
      }

      if (hits.length === 1) {
        refStringToRecordId.set(refString, hits[0].recordId);
      } else if (hits.length > 1) {
        const claimants = hits
          .map(
            (hit) =>
              `"${connectionFolders.displayNameByAccountId.get(hit.connectorAccountId) ?? hit.connectorAccountId}"`,
          )
          .join(' and ');
        throw new MalformedPseudoRefError(
          `Pseudo-ref "${refString}" is ambiguous: connections ${claimants} both use that folder name and both ` +
            `contain "${translated.folderPath}/${translated.filename}". Rename one connection so its workspace ` +
            `folder is unique, then re-publish.`,
        );
      }
      // hits.length === 0 → stays unresolved; reported by the caller like any missing target.
    }
  }

  /**
   * Apply resolved pseudo-references to an object synchronously by looking each
   * `@/…` string up in the pre-resolved `refStringToRecordId` map. A ref that
   * resolved to no record id throws, naming the connection-relative folder and
   * file the ref was read as.
   */
  private applyPseudoRefsSync(
    content: unknown,
    refStringToRecordId: Map<string, string>,
    connectionFolders: ConnectionFolderIndex,
  ): unknown {
    if (typeof content === 'string' && content.startsWith('@/')) {
      const recordId = refStringToRecordId.get(content);
      if (recordId === undefined) {
        const { folderPath, filename } = this.translatePseudoRef(content, connectionFolders);
        throw new Error(
          `Cannot resolve pseudo-ref "${content}": no record ID found in FileIndex for folder="${folderPath}" file="${filename}"`,
        );
      }
      return recordId;
    } else if (Array.isArray(content)) {
      return content.map((item) => this.applyPseudoRefsSync(item, refStringToRecordId, connectionFolders));
    } else if (typeof content === 'object' && content !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(content)) {
        result[key] = this.applyPseudoRefsSync(value, refStringToRecordId, connectionFolders);
      }
      return result;
    }
    return content;
  }

  /**
   * The `@/…` pseudo-ref strings in a batch of contents that do NOT resolve to a
   * record id in the FileIndex — computed with the exact same resolution logic
   * {@link resolveBatchPseudoRefs} uses, so a ref counts as unresolvable here iff
   * that method would throw on it. The publish backfill phase uses this to DROP a
   * relation link whose target record never landed (its create failed, or it isn't
   * in this plan) instead of failing the whole dependent record (DEV-10954). Only
   * `@/` refs are considered (not `@asset/`). Returns an empty set when the batch
   * carries no pseudo-refs (no DB work in the common case).
   *
   * A MALFORMED ref (not workspace-absolute) still throws {@link MalformedPseudoRefError}
   * here rather than being reported as unresolvable: "the target never landed" is a link
   * worth dropping, but "this ref names no connection" is a defect the user has to fix, and
   * dropping it silently would hide it.
   */
  async findUnresolvablePseudoRefs(workbookId: string, contents: ParsedContent[]): Promise<Set<string>> {
    const refStrings = new Set<string>();
    for (const content of contents) {
      this.collectPseudoRefStrings(content, refStrings);
    }
    if (refStrings.size === 0) return new Set();

    const connectionFolders = await this.buildConnectionFolderToAccountIdsMap(workbookId);
    const refStringToRecordId = await this.resolvePseudoRefStrings(workbookId, [...refStrings], connectionFolders);

    const unresolvableRefStrings = new Set<string>();
    for (const refString of refStrings) {
      if (!refStringToRecordId.has(refString)) unresolvableRefStrings.add(refString);
    }
    return unresolvableRefStrings;
  }

  /**
   * Extract all `@asset/<assetDbId>` references from an object recursively.
   */
  private extractAssetRefs(content: unknown, refs: Set<string>): void {
    if (typeof content === 'string' && content.startsWith('@asset/')) {
      refs.add(content.substring(7));
    } else if (Array.isArray(content)) {
      for (const item of content) {
        this.extractAssetRefs(item, refs);
      }
    } else if (typeof content === 'object' && content !== null) {
      for (const value of Object.values(content)) {
        this.extractAssetRefs(value, refs);
      }
    }
  }

  /**
   * Replace `@asset/<assetDbId>` references with the resolved value from the asset ref map.
   * The map values are produced by `connector.resolveAssetReference()` and may be strings,
   * objects, or numbers depending on the destination connector.
   */
  private applyAssetRefs(content: unknown, assetRefMap: Map<string, unknown>): unknown {
    if (typeof content === 'string' && content.startsWith('@asset/')) {
      const assetId = content.substring(7);
      const resolved = assetRefMap.get(assetId);
      if (resolved === undefined) {
        throw new Error(`Cannot resolve asset pseudo-ref "${content}": no Asset found with id="${assetId}"`);
      }
      return resolved;
    } else if (Array.isArray(content)) {
      return content.map((item) => this.applyAssetRefs(item, assetRefMap));
    } else if (typeof content === 'object' && content !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(content)) {
        result[key] = this.applyAssetRefs(value, assetRefMap);
      }
      return result;
    }
    return content;
  }

  /**
   * Bulk resolve pseudo-references for an entire batch of operations to avoid N+1 queries.
   * Resolves both `@/` (file index) and `@asset/` (asset) pseudo-references.
   *
   * @param assetResolver - Connector-specific function that converts an Asset row into the
   *   value to write into the record (e.g. URL string for Webflow, integer ID for WordPress).
   *   Defaults to using `remoteAssetId` if not provided (backward compatible).
   */
  async resolveBatchPseudoRefs(
    workbookId: string,
    unresolvedContents: ParsedContent[],
    assetResolver?: (asset: { remoteAssetId: string; rehostedUrl: string | null; url: string | null }) => unknown,
  ): Promise<Record<string, unknown>[]> {
    // 1. Resolve @/ pseudo-refs (file index lookups). Collect the ref strings
    //    first, and only hit the DB for the connection folder → account map when
    //    the batch actually contains a pseudo-ref. The common publish batch has
    //    none, and this is on the publish dispatch hot path, so the map query and
    //    all FileIndex lookups are skipped in that case.
    const refStrings = new Set<string>();
    for (const content of unresolvedContents) {
      this.collectPseudoRefStrings(content, refStrings);
    }
    const connectionFolders =
      refStrings.size > 0 ? await this.buildConnectionFolderToAccountIdsMap(workbookId) : EMPTY_CONNECTION_FOLDER_INDEX;
    const refStringToRecordId = await this.resolvePseudoRefStrings(workbookId, [...refStrings], connectionFolders);

    let resolved = unresolvedContents.map(
      (content) => this.applyPseudoRefsSync(content, refStringToRecordId, connectionFolders) as ParsedContent,
    );

    // 2. Resolve @asset/ pseudo-refs using the connector's resolver
    const assetIds = new Set<string>();
    for (const content of resolved) {
      this.extractAssetRefs(content, assetIds);
    }

    if (assetIds.size > 0) {
      const assets = await this.db.client.asset.findMany({
        where: { id: { in: [...assetIds] } },
        select: { id: true, remoteAssetId: true, rehostedUrl: true, url: true },
      });

      const assetRefMap = new Map<string, unknown>();
      for (const asset of assets) {
        assetRefMap.set(asset.id, assetResolver ? assetResolver(asset) : asset.remoteAssetId);
      }

      resolved = resolved.map((content) => this.applyAssetRefs(content, assetRefMap) as ParsedContent);
    }

    return resolved;
  }
}

/**
 * The FileIndex lookup a translated ref resolves to. Only valid for an UNAMBIGUOUS ref
 * (exactly one candidate connection) — an ambiguous one is probed per candidate instead, so it
 * has no single lookup.
 */
function asFileIndexLookup(ref: TranslatedPseudoRef): FileIndexLookup {
  return {
    folderPath: ref.folderPath,
    filename: ref.filename,
    connectorAccountId: ref.candidateConnectorAccountIds[0],
  };
}

/**
 * Dedupe translated refs for a single bulk FileIndex lookup, keyed by connection + folder +
 * filename. Two connections sharing a folderPath are both queried AND both come back
 * distinctly, because the result map is keyed by connection too (see `fileIndexLookupKey`).
 */
function dedupeRefs(refs: TranslatedPseudoRef[]): FileIndexLookup[] {
  const byKey = new Map<string, FileIndexLookup>();
  for (const ref of refs) {
    const lookup = asFileIndexLookup(ref);
    byKey.set(fileIndexLookupKey(lookup), lookup);
  }
  return [...byKey.values()];
}

interface FileIndexLookup {
  folderPath: string;
  filename: string;
  connectorAccountId: string;
}
