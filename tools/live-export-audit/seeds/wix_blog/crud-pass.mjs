#!/usr/bin/env node
/**
 * Wix Blog source-side CRUD pass for the Live Export audit (Phase 4).
 *
 * Applies ONE round of changes through Wix's own API — 2 edits (one of them touching the long
 * rich-content body), 1 create, 1 delete — so the audit can re-run each destination workbook and
 * verify that every change class is mirrored. Prints the ids/values to assert against.
 *
 * Usage: crud-pass.mjs --env <server/.env path> --instance <wix instanceId>
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
const CREATED_TITLE = 'fable_qa 13 crud created';
const existingCreated = byTitle.get(CREATED_TITLE);
if (existingCreated) {
  outcome.created = { id: existingCreated.id, title: CREATED_TITLE, note: 'already existed — reused' };
  log('create target already exists', existingCreated.id);
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

const after = await listAllDraftPosts();
outcome.totalDraftPostsAfter = after.length;
log(`site now has ${after.length} draft posts`);
console.log(JSON.stringify(outcome, null, 1));
