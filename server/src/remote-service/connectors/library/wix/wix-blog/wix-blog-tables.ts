import { sanitizeForTableWsId } from '../../../ids';
import { EntityId } from '../../../types';

/**
 * The canonical id for every table the Wix Blog connector exposes.
 *
 * There is ONE definition per table and everything else derives from it — the table previews,
 * the JSON schemas, the foreign-key annotations, and the pull router. That matters because a
 * foreign key resolves by matching its `linkedTableId` against the candidate tokens derived from
 * the TARGET folder's `remoteTableId` (`linkedTableIdCandidateTokensForRemoteTableId`), i.e. against
 * the **remote** id — never against the sanitized `wsId`. The two differ (`sanitizeForTableWsId`
 * maps `-` → `_`), and hand-writing `linkedTableId: 'wix_blog'` next to `remoteId: ['wix-blog']` is
 * exactly the mismatch that made every Wix foreign key permanently `needs_target` (DEV-11116).
 * Deriving both from this table keeps them impossible to drift apart.
 */
export const WIX_BLOG_TABLE_REMOTE_IDS = {
  posts: 'wix-blog',
  categories: 'wix-blog-categories',
  tags: 'wix-blog-tags',
  members: 'wix-members',
} as const;

export type WixBlogTableKey = keyof typeof WIX_BLOG_TABLE_REMOTE_IDS;

export const WIX_BLOG_TABLE_DISPLAY_NAMES: Record<WixBlogTableKey, string> = {
  posts: 'Blog Posts',
  categories: 'Categories',
  tags: 'Tags',
  members: 'Members',
};

/** The `EntityId` for one of this connector's tables — `wsId` derived, `remoteId` canonical. */
export function wixBlogEntityId(table: WixBlogTableKey): EntityId {
  const remoteId = WIX_BLOG_TABLE_REMOTE_IDS[table];
  return { wsId: sanitizeForTableWsId(remoteId), remoteId: [remoteId] };
}

/**
 * The foreign-key annotation pointing at one of this connector's tables. Emits BOTH forms the
 * platform understands: `linkedTableId` (the remote token, which is what FK resolution matches on)
 * and `linkedTableRemoteId` (the full remote id array, for consumers that bind by array equality).
 */
export function wixBlogForeignKeyTo(
  table: WixBlogTableKey,
  opts?: { isSingleValued?: boolean },
): { linkedTableId: string; linkedTableRemoteId: string[]; isSingleValued?: boolean } {
  const id = wixBlogEntityId(table);
  return {
    linkedTableId: WIX_BLOG_TABLE_REMOTE_IDS[table],
    linkedTableRemoteId: id.remoteId,
    ...(opts?.isSingleValued !== undefined ? { isSingleValued: opts.isSingleValued } : {}),
  };
}

/** Resolve a table's key from the `EntityId` a caller hands us, or `undefined` if unrecognized. */
export function wixBlogTableKeyFromEntityId(id: EntityId): WixBlogTableKey | undefined {
  const remoteId = id.remoteId[0];
  return (Object.keys(WIX_BLOG_TABLE_REMOTE_IDS) as WixBlogTableKey[]).find(
    (key) => WIX_BLOG_TABLE_REMOTE_IDS[key] === remoteId,
  );
}
