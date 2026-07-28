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
