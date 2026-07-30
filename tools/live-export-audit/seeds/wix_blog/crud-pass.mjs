#!/usr/bin/env node
/**
 * Wix Blog source-side CRUD pass for the Live Export audit (Phase 4).
 *
 * Applies ONE round of changes through Wix's own API — 2 post edits (one of them touching the long
 * rich-content body), 1 post create, 1 post delete, plus one edit on the Categories reference table
 * — so the audit can re-run each destination workbook and verify that every change class is
 * mirrored. Prints the ids/values to assert against.
 *
 * `--create-title` exists because the create target has to be a title the site does NOT already
 * have: a previous pass leaves its created post behind, and reusing that record turns the create
 * assertion into a no-op. Each audit round passes the next unused title.
 *
 * Usage: crud-pass.mjs --env <server/.env path> --instance <wix instanceId>
 *          [--create-title "fable_qa 13 crud created"]
 */
import { connectToWix } from './wix-api.mjs';

const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].slice(2)] = next === undefined || next.startsWith('--') ? true : (i++, next);
  }
}
if (!args.env || !args.instance) {
  console.error('Usage: crud-pass.mjs --env <server/.env path> --instance <wix instanceId>');
  process.exit(1);
}
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);
const wix = await connectToWix({ envFile: args.env, instanceId: args.instance });

async function listAllDraftPosts() {
  const all = [];
  for (let offset = 0; ; offset += 100) {
    const page = await wix('GET', `/blog/v3/draft-posts?paging.limit=100&paging.offset=${offset}&fieldsets=RICH_CONTENT`);
    const posts = page.draftPosts ?? [];
    all.push(...posts);
    if (posts.length === 0 || all.length >= (page.metaData?.total ?? all.length)) break;
  }
  return all;
}

const posts = await listAllDraftPosts();
const byTitle = new Map(posts.map((p) => [p.title, p]));
const memberId = posts[0]?.memberId;
log(`site has ${posts.length} draft posts`);

const text = (value) => ({ type: 'TEXT', id: '', nodes: [], textData: { text: value, decorations: [] } });
const paragraph = (value, id) => ({ type: 'PARAGRAPH', id, nodes: [text(value)], paragraphData: {} });

const outcome = {};

// ── Edit 1: the long-text record — rewrite the >4000 char body and the excerpt ───────────────
const longtext = byTitle.get('fable_qa 03 longtext');
if (!longtext) throw new Error('seed record "fable_qa 03 longtext" missing — run seed.mjs first');
const EDITED_LONG_BODY = 'CRUD-EDITED ' + 'Z'.repeat(4300);
const EDITED_EXCERPT = 'CRUD-EDITED excerpt — 🥺 日本語 "quoted" line1\nline2';
await wix('PATCH', `/blog/v3/draft-posts/${longtext.id}?fieldsets=RICH_CONTENT`, {
  draftPost: { ...longtext, excerpt: EDITED_EXCERPT, richContent: { nodes: [paragraph(EDITED_LONG_BODY, 'crud_edit_1')], documentStyle: {} } },
});
outcome.editedLongText = { id: longtext.id, expectedExcerpt: EDITED_EXCERPT, expectedBodyLength: EDITED_LONG_BODY.length };
log('edited (long text)', longtext.id);

// ── Edit 2: scalar/boolean/array flip on a second record ────────────────────────────────────
const flags = byTitle.get('fable_qa 09 flags');
if (!flags) throw new Error('seed record "fable_qa 09 flags" missing — run seed.mjs first');
await wix('PATCH', `/blog/v3/draft-posts/${flags.id}?fieldsets=RICH_CONTENT`, {
  draftPost: { ...flags, excerpt: 'CRUD-EDITED flags excerpt', featured: false, commentingEnabled: true, hashtags: ['crud-edited-tag'] },
});
outcome.editedFlags = { id: flags.id, expectedExcerpt: 'CRUD-EDITED flags excerpt', expectedFeatured: false, expectedHashtags: 'crud-edited-tag' };
log('edited (flags)', flags.id);

// ── Create 1 ────────────────────────────────────────────────────────────────────────────────
const CREATED_TITLE = typeof args['create-title'] === 'string' ? args['create-title'] : 'fable_qa 13 crud created';
const existingCreated = byTitle.get(CREATED_TITLE);
if (existingCreated) {
  outcome.created = { id: existingCreated.id, title: CREATED_TITLE, note: 'ALREADY EXISTED — no create was exercised this round; pass a fresh --create-title' };
  log('WARNING: create target already exists, no create exercised —', existingCreated.id);
} else {
  const created = await wix('POST', '/blog/v3/draft-posts?fieldsets=RICH_CONTENT', {
    draftPost: { title: CREATED_TITLE, memberId, excerpt: 'created during the CRUD pass', richContent: { nodes: [paragraph('Body of the CRUD-created post.', 'crud_create_1')], documentStyle: {} } },
  });
  outcome.created = { id: created.draftPost?.id, title: CREATED_TITLE };
  log('created', created.draftPost?.id);
}

// ── Delete 1 ────────────────────────────────────────────────────────────────────────────────
const toDelete = byTitle.get('fable_qa 11 dangling fk');
if (toDelete) {
  await wix('DELETE', `/blog/v3/draft-posts/${toDelete.id}?permanent=true`);
  outcome.deleted = { id: toDelete.id, title: 'fable_qa 11 dangling fk' };
  log('deleted', toDelete.id);
} else {
  outcome.deleted = { note: 'already deleted on a previous pass' };
}

// ── Edit 3: a Categories row ────────────────────────────────────────────────────────────────
// Categories/Tags/Members became real exported tables in the Round 2 connector work, so a change
// class that only touches a reference table has to be mirrored too — the posts table alone no
// longer proves the export tracks the source.
const categories = (await wix('GET', '/blog/v3/categories?paging.limit=100')).categories ?? [];
const categoryToEdit = categories.find((c) => c.label === 'fable_qa cat alpha');
if (categoryToEdit) {
  const EDITED_CATEGORY_DESCRIPTION = `CRUD-EDITED category description — 🥺 日本語 "quoted"`;
  // Wix's own read/write shapes disagree: Get Category returns `displayPosition: -1` for a category
  // hidden from the menu, but Update Category rejects it with `got -1, expected 0 or more`. So a
  // read-modify-write of an untouched category 400s. Drop the field rather than invent a position.
  const { displayPosition, ...categoryWithoutUnwritableDisplayPosition } = categoryToEdit;
  await wix('PATCH', `/blog/v3/categories/${categoryToEdit.id}`, {
    category: { ...categoryWithoutUnwritableDisplayPosition, description: EDITED_CATEGORY_DESCRIPTION },
  });
  outcome.editedCategory = {
    id: categoryToEdit.id,
    label: categoryToEdit.label,
    expectedDescription: EDITED_CATEGORY_DESCRIPTION,
  };
  log('edited (category)', categoryToEdit.id);
} else {
  outcome.editedCategory = { note: 'seed category "fable_qa cat alpha" missing — run seed.mjs first' };
}

// ── Change 4: publish a post ────────────────────────────────────────────────────────────────
// Every seeded post is a pure draft, which leaves two things unproven: that a PUBLISHED post is
// pulled at all (the connector only ever calls `listDraftPosts`), and that `firstPublishedDate` —
// the one date column that is empty on 100% of drafts — is ever populated. Publishing one post
// exercises both. Idempotent: skipped if the post is already published.
const toPublish = byTitle.get('fable_qa 09 flags');
if (toPublish && toPublish.status !== 'PUBLISHED') {
  await wix('POST', `/blog/v3/draft-posts/${toPublish.id}/publish`, {});
  const republished = await wix('GET', `/blog/v3/draft-posts/${toPublish.id}?fieldsets=RICH_CONTENT`);
  outcome.published = {
    id: toPublish.id,
    title: toPublish.title,
    statusAfter: republished.draftPost?.status,
    firstPublishedDateAfter: republished.draftPost?.firstPublishedDate ?? null,
  };
  log('published', toPublish.id, '→', republished.draftPost?.status);
} else {
  outcome.published = { note: toPublish ? 'already PUBLISHED' : 'post missing — run seed.mjs first' };
}

const after = await listAllDraftPosts();
outcome.totalDraftPostsAfter = after.length;
outcome.statusCountsAfter = after.reduce((counts, post) => {
  counts[post.status ?? 'UNKNOWN'] = (counts[post.status ?? 'UNKNOWN'] ?? 0) + 1;
  return counts;
}, {});
log(`site now has ${after.length} draft posts`);
console.log(JSON.stringify(outcome, null, 1));
