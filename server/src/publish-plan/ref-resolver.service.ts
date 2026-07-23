import { Injectable } from '@nestjs/common';
import { DbService } from 'src/db/db.service';
import { ParsedContent } from 'src/utils/objects';
import {
  sanitizeConnectionFolderName,
  sanitizeLegacyConnectionFolderName,
} from 'src/workbook/connector-folder-path.util';
import { FileIndexService } from './file-index.service';
import { parsePath } from './utils';

/**
 * A pseudo-ref (`@/…`), already stripped of the `@/` marker and translated from
 * the user-facing workspace-absolute form into the internal, connection-scoped
 * form the FileIndex is keyed by. See {@link RefResolverService.translatePseudoRef}.
 */
interface TranslatedPseudoRef {
  /**
   * The connection the ref points at. Resolved from the ref's leading connection
   * folder segment; falls back to the plan's connection for a legacy
   * connection-relative ref (one with no connection segment). May be null when
   * no plan connection was supplied (then the lookup is workbook-global).
   */
  connectorAccountId: string | null;
  /** Connection-relative folder path (no connection segment, no leading slash). */
  folderPath: string;
  filename: string;
}

@Injectable()
export class RefResolverService {
  constructor(
    private readonly fileIndexService: FileIndexService,
    private readonly db: DbService,
  ) {}

  /**
   * Build the map from a workbook's connection folder names (the first segment of
   * a workspace-absolute pseudo-ref) to their `connectorAccountId`.
   *
   * A pseudo-ref is user-facing and lives in the one-tree model, where each
   * connection is a top-level folder named after its (sanitized) display name.
   * Internally each connection is its own git repo keyed connection-relative, so
   * to resolve a ref we must map its leading segment back to a connection. We
   * register BOTH naming schemes a workspace may have used — the bare sanitized
   * display name and the legacy `"<SERVICE> - <displayName>"` form — so refs
   * authored under either layout resolve. If two connections would claim the
   * same folder name, that name is treated as ambiguous and dropped, so such a
   * ref falls back to the plan connection rather than silently resolving to the
   * wrong one.
   */
  private async buildConnectionFolderToAccountIdMap(workbookId: string): Promise<Map<string, string>> {
    const connectorAccounts = await this.db.client.connectorAccount.findMany({
      where: { workbookId },
      select: { id: true, service: true, displayName: true },
    });

    const folderNameToAccountId = new Map<string, string>();
    const ambiguousFolderNames = new Set<string>();
    const register = (folderName: string, connectorAccountId: string) => {
      if (folderName.length === 0) return;
      const existing = folderNameToAccountId.get(folderName);
      if (existing !== undefined && existing !== connectorAccountId) {
        ambiguousFolderNames.add(folderName);
        return;
      }
      folderNameToAccountId.set(folderName, connectorAccountId);
    };

    for (const account of connectorAccounts) {
      register(sanitizeConnectionFolderName(account.displayName), account.id);
      register(sanitizeLegacyConnectionFolderName(account.service, account.displayName), account.id);
    }
    for (const ambiguousName of ambiguousFolderNames) {
      folderNameToAccountId.delete(ambiguousName);
    }
    return folderNameToAccountId;
  }

  /**
   * Translate one `@/…` pseudo-ref string into its connection-scoped lookup key.
   *
   * Canonical (workspace-absolute) refs lead with a connection folder segment
   * (`@/HubSpot/Contacts/x.json`); we peel it off and map it to a connection.
   * Legacy connection-relative refs (`@/Contacts/x.json`, still on disk from
   * before this change and from the sync producer pre-fix) have no connection
   * segment, so we resolve them within the plan's own connection. This dual
   * handling is the "lenient during rollout" read that lets both forms resolve
   * without a flag-day or on-disk data migration.
   */
  private translatePseudoRef(
    pseudoRefString: string,
    connectionFolderToAccountId: Map<string, string>,
    planConnectorAccountId: string | null,
  ): TranslatedPseudoRef {
    const targetPath = pseudoRefString.substring(2); // strip the '@/' marker
    const firstSlashIndex = targetPath.indexOf('/');
    if (firstSlashIndex !== -1) {
      const firstSegment = targetPath.substring(0, firstSlashIndex);
      const matchedConnectorAccountId = connectionFolderToAccountId.get(firstSegment);
      if (matchedConnectorAccountId !== undefined) {
        // Workspace-absolute: the first segment is a known connection folder.
        const connectionRelativePath = targetPath.substring(firstSlashIndex + 1);
        const { folderPath, filename } = parsePath(connectionRelativePath);
        return { connectorAccountId: matchedConnectorAccountId, folderPath, filename };
      }
    }
    // Legacy connection-relative ref: resolve within the plan's connection.
    const { folderPath, filename } = parsePath(targetPath);
    return { connectorAccountId: planConnectorAccountId, folderPath, filename };
  }

  /**
   * The legacy connection-relative interpretation of a ref — the whole path
   * resolved within the plan's connection. Used as a fallback when the primary
   * (workspace-absolute) interpretation doesn't resolve, e.g. a legacy ref whose
   * first folder segment happens to equal a connection display name and so was
   * wrongly peeled as a connection segment by the primary translation.
   */
  private legacyTranslation(pseudoRefString: string, planConnectorAccountId: string | null): TranslatedPseudoRef {
    const { folderPath, filename } = parsePath(pseudoRefString.substring(2));
    return { connectorAccountId: planConnectorAccountId, folderPath, filename };
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
   * Two passes: first the primary (workspace-absolute) interpretation for all
   * refs in one bulk FileIndex lookup; then — only for refs that missed AND whose
   * legacy interpretation differs — the legacy connection-relative interpretation
   * within the plan connection, in a second bulk lookup. So the common case pays
   * exactly one query and the fallback only fires for genuinely unresolved refs.
   * Unresolvable refs are absent from the returned map (the caller throws with
   * context).
   */
  private async resolvePseudoRefStrings(
    workbookId: string,
    refStrings: string[],
    connectionFolderToAccountId: Map<string, string>,
    planConnectorAccountId: string | null,
  ): Promise<Map<string, string>> {
    const refStringToRecordId = new Map<string, string>();
    if (refStrings.length === 0) return refStringToRecordId;

    // Primary pass — workspace-absolute interpretation.
    const primaryByRefString = new Map<string, TranslatedPseudoRef>();
    for (const refString of refStrings) {
      primaryByRefString.set(
        refString,
        this.translatePseudoRef(refString, connectionFolderToAccountId, planConnectorAccountId),
      );
    }
    const primaryMap = await this.fileIndexService.getRecordIds(
      workbookId,
      dedupeRefs([...primaryByRefString.values()]),
    );

    const unresolvedRefStrings: string[] = [];
    for (const [refString, primary] of primaryByRefString) {
      const recordId = primaryMap.get(`${primary.folderPath}:${primary.filename}`);
      if (recordId) {
        refStringToRecordId.set(refString, recordId);
      } else {
        unresolvedRefStrings.push(refString);
      }
    }

    // Lazy fallback pass — legacy connection-relative interpretation, only for
    // refs the primary pass couldn't resolve and whose legacy reading is actually
    // different (i.e. the primary stripped a connection segment).
    const fallbackByRefString = new Map<string, TranslatedPseudoRef>();
    for (const refString of unresolvedRefStrings) {
      const primary = primaryByRefString.get(refString);
      const legacy = this.legacyTranslation(refString, planConnectorAccountId);
      if (
        primary &&
        primary.folderPath === legacy.folderPath &&
        primary.connectorAccountId === legacy.connectorAccountId
      ) {
        continue; // primary already WAS the legacy interpretation — no new candidate
      }
      fallbackByRefString.set(refString, legacy);
    }
    if (fallbackByRefString.size > 0) {
      const fallbackMap = await this.fileIndexService.getRecordIds(
        workbookId,
        dedupeRefs([...fallbackByRefString.values()]),
      );
      for (const [refString, legacy] of fallbackByRefString) {
        const recordId = fallbackMap.get(`${legacy.folderPath}:${legacy.filename}`);
        if (recordId) refStringToRecordId.set(refString, recordId);
      }
    }

    return refStringToRecordId;
  }

  /**
   * Apply resolved pseudo-references to an object synchronously by looking each
   * `@/…` string up in the pre-resolved `refStringToRecordId` map. A ref that
   * resolved to no record id throws, naming the primary interpretation's folder
   * and file so the error matches how the ref was read.
   */
  private applyPseudoRefsSync(
    content: unknown,
    refStringToRecordId: Map<string, string>,
    connectionFolderToAccountId: Map<string, string>,
    planConnectorAccountId: string | null,
  ): unknown {
    if (typeof content === 'string' && content.startsWith('@/')) {
      const recordId = refStringToRecordId.get(content);
      if (recordId === undefined) {
        const { folderPath, filename } = this.translatePseudoRef(
          content,
          connectionFolderToAccountId,
          planConnectorAccountId,
        );
        throw new Error(
          `Cannot resolve pseudo-ref "${content}": no record ID found in FileIndex for folder="${folderPath}" file="${filename}"`,
        );
      }
      return recordId;
    } else if (Array.isArray(content)) {
      return content.map((item) =>
        this.applyPseudoRefsSync(item, refStringToRecordId, connectionFolderToAccountId, planConnectorAccountId),
      );
    } else if (typeof content === 'object' && content !== null) {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(content)) {
        result[key] = this.applyPseudoRefsSync(
          value,
          refStringToRecordId,
          connectionFolderToAccountId,
          planConnectorAccountId,
        );
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
   */
  async findUnresolvablePseudoRefs(
    workbookId: string,
    contents: ParsedContent[],
    planConnectorAccountId?: string | null,
  ): Promise<Set<string>> {
    const refStrings = new Set<string>();
    for (const content of contents) {
      this.collectPseudoRefStrings(content, refStrings);
    }
    if (refStrings.size === 0) return new Set();

    const connectionFolderToAccountId = await this.buildConnectionFolderToAccountIdMap(workbookId);
    const refStringToRecordId = await this.resolvePseudoRefStrings(
      workbookId,
      [...refStrings],
      connectionFolderToAccountId,
      planConnectorAccountId ?? null,
    );

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
    // The connection this publish plan targets. Used to (a) resolve legacy
    // connection-relative refs within the right connection and (b) disambiguate
    // a workspace-absolute ref to a folder that two connections share. Optional
    // for backward compatibility / non-publish callers; when absent, lookups are
    // workbook-global (the pre-DEV-10880 behavior).
    planConnectorAccountId?: string | null,
  ): Promise<Record<string, unknown>[]> {
    const planConnection = planConnectorAccountId ?? null;

    // 1. Resolve @/ pseudo-refs (file index lookups). Collect the ref strings
    //    first, and only hit the DB for the connection folder → account map when
    //    the batch actually contains a pseudo-ref. The common publish batch has
    //    none, and this is on the publish dispatch hot path, so the map query and
    //    all FileIndex lookups are skipped in that case.
    const refStrings = new Set<string>();
    for (const content of unresolvedContents) {
      this.collectPseudoRefStrings(content, refStrings);
    }
    const connectionFolderToAccountId =
      refStrings.size > 0 ? await this.buildConnectionFolderToAccountIdMap(workbookId) : new Map<string, string>();
    const refStringToRecordId = await this.resolvePseudoRefStrings(
      workbookId,
      [...refStrings],
      connectionFolderToAccountId,
      planConnection,
    );

    let resolved = unresolvedContents.map(
      (content) =>
        this.applyPseudoRefsSync(
          content,
          refStringToRecordId,
          connectionFolderToAccountId,
          planConnection,
        ) as ParsedContent,
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
 * Dedupe translated refs for a single bulk FileIndex lookup, keyed by
 * connection + folder + filename so two connections that share a folderPath are
 * both queried (the returned map is keyed folderPath:filename, so a same-file
 * cross-connection collision within one batch still collapses — a documented,
 * astronomically-rare limitation, see docs/pseudo-refs.md).
 */
function dedupeRefs(refs: TranslatedPseudoRef[]): TranslatedPseudoRef[] {
  const byKey = new Map<string, TranslatedPseudoRef>();
  for (const ref of refs) {
    byKey.set(`${ref.connectorAccountId ?? ''}:${ref.folderPath}:${ref.filename}`, ref);
  }
  return [...byKey.values()];
}
