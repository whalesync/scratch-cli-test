import { readFieldValueAtPath } from 'src/utils/field-path';
import type { ForeignKeyTargetResolution } from './transformer.types';

/**
 * An index of one referenced folder's source records by a NON-ID key — the field a foreign key's
 * value names its target by when that value isn't the target's remote id (Framer's references name
 * their target by `slug`; a Postgres foreign key may reference a non-primary-key unique column).
 *
 * Ambiguity is tracked rather than resolved. A key value claimed by two target records is a data
 * error the user needs to see, so it is kept OUT of the resolvable map and counted separately —
 * a last-write-wins `Map.set` would silently link the wrong record.
 */
export interface ForeignKeyTargetKeyIndex {
  /** Key value → the one target record's source remote id. Ambiguous values are absent. */
  targetSourceRemoteIdByKeyValue: Map<string, string>;
  /** Key value → how many target records claim it. Only values claimed by two or more appear. */
  claimCountByAmbiguousKeyValue: Map<string, number>;
}

/** One referenced source record, as `parseFileToRecord` produces it. */
export interface TargetRecordForKeyIndex {
  /** The record's source remote id (the value at the target folder's schema `idPath`). */
  id: string;
  /** The record's parsed JSON body. */
  fields: unknown;
}

/**
 * Build a {@link ForeignKeyTargetKeyIndex} over a referenced folder's records.
 *
 * PURE — no I/O, so the matching rules are testable on their own. Key values are compared as
 * strings via the same `String()` coercion the FK path already applies to the referencing value,
 * so a numeric key (a Postgres `REFERENCES other(legacy_code)`) matches whether it is stored as a
 * number or a string. A record whose key path is missing, null, or a non-scalar simply isn't
 * indexed — it cannot be named by that key, which is different from being ambiguous.
 */
export function buildForeignKeyTargetKeyIndex(
  targetRecords: TargetRecordForKeyIndex[],
  targetKeyPath: string,
): ForeignKeyTargetKeyIndex {
  const targetSourceRemoteIdByKeyValue = new Map<string, string>();
  const claimCountByAmbiguousKeyValue = new Map<string, number>();

  for (const targetRecord of targetRecords) {
    const rawKeyValue = readFieldValueAtPath(targetRecord.fields, targetKeyPath);
    if (rawKeyValue === null || rawKeyValue === undefined) continue;
    if (typeof rawKeyValue !== 'string' && typeof rawKeyValue !== 'number' && typeof rawKeyValue !== 'boolean') {
      continue;
    }
    const keyValue = String(rawKeyValue);

    const alreadyAmbiguousClaimCount = claimCountByAmbiguousKeyValue.get(keyValue);
    if (alreadyAmbiguousClaimCount !== undefined) {
      claimCountByAmbiguousKeyValue.set(keyValue, alreadyAmbiguousClaimCount + 1);
      continue;
    }
    if (targetSourceRemoteIdByKeyValue.has(keyValue)) {
      // Second claimant: demote the value from resolvable to ambiguous.
      targetSourceRemoteIdByKeyValue.delete(keyValue);
      claimCountByAmbiguousKeyValue.set(keyValue, 2);
      continue;
    }
    targetSourceRemoteIdByKeyValue.set(keyValue, targetRecord.id);
  }

  return { targetSourceRemoteIdByKeyValue, claimCountByAmbiguousKeyValue };
}

/**
 * Look a foreign key's value up in a built index. Exact match only — no case folding, no
 * trimming, and no fallback to remote-id matching, so a declared key path means that key alone.
 */
export function resolveForeignKeyValueAgainstTargetKeyIndex(
  index: ForeignKeyTargetKeyIndex,
  foreignKeyValue: string,
): ForeignKeyTargetResolution {
  const ambiguousClaimCount = index.claimCountByAmbiguousKeyValue.get(foreignKeyValue);
  if (ambiguousClaimCount !== undefined) return { kind: 'ambiguous', matchCount: ambiguousClaimCount };

  const targetSourceRemoteId = index.targetSourceRemoteIdByKeyValue.get(foreignKeyValue);
  if (targetSourceRemoteId === undefined) return { kind: 'no_match' };
  return { kind: 'resolved', targetSourceRemoteId };
}
