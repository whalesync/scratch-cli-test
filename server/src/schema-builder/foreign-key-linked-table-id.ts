/**
 * Reconciles the two forms a foreign key's target table is named by: the single `linkedTableId`
 * string a connector annotates an FK column with, and the ordered id-segment array a DataFolder
 * carries as its `tableId`.
 */

/**
 * Every token a foreignKey's `linkedTableId` (and the `{ unresolvedLinkedTableId }` target derived
 * from it) may legitimately use to name the table whose folder carries `remoteTableId`. Shared by
 * the plan generator and all three sync-draft FK binding sites so plan generation,
 * validate-at-save, bind-at-materialize, and the resolution-transformer lookup agree on what
 * "points at a table in this plan/draft" means.
 *
 * A connector annotates a linked table with ONE string, but a folder's `tableId` is an ordered
 * segment array (Supabase/Postgres: `['<projectRef>', '<schema>', '<table>']`), so the two forms
 * are reconciled by candidate tokens rather than by equality:
 *  - each dot-joined suffix of the segments — the qualified form (`fable_qa.authors`, and the
 *    fully-qualified `<projectRef>.fable_qa.authors`). Without these, a foreign key into a
 *    NON-`public` schema — which the pg connectors emit as `"<schema>.<table>"` — matched no
 *    token, so the plan never bound it to its sibling table and any draft containing one was
 *    rejected at save with 422 `SYNC_DRAFT_FK_TARGET_MISSING` even though the target table was
 *    right there in the draft (DEV-11071).
 *  - each individual segment — the bare form (the pg connectors emit just `authors` for a
 *    `public`-schema foreign key; Airtable emits the bare `tblXxx`).
 *
 * Tokens are claimed independently by each caller's first-wins map, so the order here carries no
 * meaning; the qualified token is what disambiguates two same-named tables in different schemas.
 */
export function linkedTableIdCandidateTokensForRemoteTableId(remoteTableId: string[]): string[] {
  const candidateTokens = new Set<string>();
  for (let suffixStartIndex = 0; suffixStartIndex < remoteTableId.length; suffixStartIndex++) {
    candidateTokens.add(remoteTableId.slice(suffixStartIndex).join('.'));
  }
  for (const remoteTableIdSegment of remoteTableId) {
    candidateTokens.add(remoteTableIdSegment);
  }
  return [...candidateTokens];
}

/**
 * The EXACT-identity key for a remote table id: the form a foreign key names its target by when the connector emits
 * `linkedTableRemoteId` — the linked table's full segment array, deep-equal to that table's `DataFolder.tableId`.
 *
 * Kept in its own key namespace (a NUL-prefixed, NUL-joined string — a NUL byte can't appear in a real id segment) so
 * an exact-identity key can never collide with one of the {@link linkedTableIdCandidateTokensForRemoteTableId} tokens
 * indexed in the same map.
 */
export function exactRemoteTableIdIdentityKey(remoteTableId: string[]): string {
  return `\u0000exact\u0000${remoteTableId.join('\u0000')}`;
}

/**
 * Every key a folder's `remoteTableId` should be INDEXED under so a foreign key naming that table — by EITHER form —
 * finds it: the exact-identity key plus the legacy candidate tokens. Pair with
 * {@link linkedTableIdLookupKeysForPendingForeignKeyTarget} at the lookup side.
 */
export function linkedTableIdIndexKeysForRemoteTableId(remoteTableId: string[]): string[] {
  return [exactRemoteTableIdIdentityKey(remoteTableId), ...linkedTableIdCandidateTokensForRemoteTableId(remoteTableId)];
}

/**
 * The keys a PENDING foreignKey target should be LOOKED UP by, most specific first: the exact-identity key of its
 * `unresolvedLinkedTableRemoteId` (when the connector emitted one), then the connector-specific
 * `unresolvedLinkedTableId` string.
 *
 * The array form is authoritative because the string form is only the connector's own name for the table and need not
 * appear in the target folder's `tableId` at all: QuickBooks annotates a foreign key with its LOWER-CASED `wsId`
 * (`'account'`) while `listTables` gives that table the RAW-cased remote id `['Account']`, so no candidate token ever
 * matched and every QuickBooks foreign key was rejected at save with 422 `SYNC_DRAFT_FK_TARGET_MISSING` — the target
 * table sitting right there in the draft (DEV-10941). The string stays as the fallback for connectors that don't emit
 * the array yet.
 */
export function linkedTableIdLookupKeysForPendingForeignKeyTarget(target: {
  unresolvedLinkedTableId: string;
  unresolvedLinkedTableRemoteId?: string[];
}): string[] {
  return linkedTableIdLookupKeys(target.unresolvedLinkedTableId, target.unresolvedLinkedTableRemoteId);
}

/**
 * The same lookup keys for a foreign key still in its CONNECTOR-annotated form (`x-scratch-foreign-key`, as surfaced
 * on a `SchemaField`), before plan generation turns it into a pending target. See
 * {@link linkedTableIdLookupKeysForPendingForeignKeyTarget}.
 */
export function linkedTableIdLookupKeysForConnectorForeignKey(foreignKey: {
  linkedTableId: string;
  linkedTableRemoteId?: string[];
}): string[] {
  return linkedTableIdLookupKeys(foreignKey.linkedTableId, foreignKey.linkedTableRemoteId);
}

function linkedTableIdLookupKeys(linkedTableId: string, linkedTableRemoteId: string[] | undefined): string[] {
  return linkedTableRemoteId && linkedTableRemoteId.length > 0
    ? [exactRemoteTableIdIdentityKey(linkedTableRemoteId), linkedTableId]
    : [linkedTableId];
}

/** The first value indexed under any of `lookupKeys`, in order — the "most specific match wins" resolution step. */
export function firstIndexedValueForLookupKeys<TIndexedValue>(
  valueByIndexKey: Map<string, TIndexedValue>,
  lookupKeys: string[],
): TIndexedValue | undefined {
  for (const lookupKey of lookupKeys) {
    const indexedValue = valueByIndexKey.get(lookupKey);
    if (indexedValue !== undefined) return indexedValue;
  }
  return undefined;
}
