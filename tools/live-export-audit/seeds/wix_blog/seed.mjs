#!/usr/bin/env node
/**
 * Wix Blog torture-data seeder for the Live Export source audit.
 *
 * Wix Blog exposes exactly ONE table (draft posts), so type coverage has to come from the
 * post's own field surface rather than from many tables. This seeds:
 *   - one all-empty record (title is required by Wix, so title-only)
 *   - unicode / newline / quote / HTML-entity / zero-width / RTL torture
 *   - long text past the 2000 and 4000 char destination caps, plus boundary values at Wix's
 *     own documented caps (title 200, excerpt 500, relatedPostIds 3)
 *   - arrays at 0 / 1 / 3+ elements, with commas and quotes inside elements
 *   - foreign keys: categoryIds, tagIds (targets Wix Blog does NOT expose as Scratch tables),
 *     relatedPostIds (self-referencing, in-export), pricingPlanIds (dangling GUID)
 *   - rich content covering headings, bold/italic/underline/strike, links, both list kinds,
 *     a code block, a blockquote, a divider and an image
 *   - 200+ records in the table so the connector's 100-per-page offset pagination has to loop
 *
 * Idempotent: records are matched by title, so a re-run updates instead of duplicating.
 *
 * Usage:
 *   node tools/live-export-audit/seeds/wix_blog/seed.mjs \
 *     --env <path to server/.env with WIX_CLIENT_ID_V2/SECRET_V2> \
 *     --instance <wix instanceId>   # = the connector account's decrypted oauthWorkspaceId
 *     [--bulk 200] [--no-bulk]
 */
import { connectToWix } from './wix-api.mjs';

const args = {};
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
}
if (!args.env || !args.instance) {
  console.error('Usage: seed.mjs --env <server/.env path> --instance <wix instanceId> [--bulk N] [--no-bulk]');
  process.exit(1);
}
const BULK_COUNT = args['no-bulk'] ? 0 : Number(args.bulk ?? 200);
const PREFIX = 'fable_qa';
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

const wix = await connectToWix({ envFile: args.env, instanceId: args.instance });

// ── Ricos rich-content builders ─────────────────────────────────────────────
let ricosNodeCounter = 0;
const nodeId = () => `qa_node_${++ricosNodeCounter}`;
const text = (value, decorations = []) => ({ type: 'TEXT', id: '', nodes: [], textData: { text: value, decorations } });
const paragraph = (...textNodes) => ({ type: 'PARAGRAPH', id: nodeId(), nodes: textNodes, paragraphData: {} });
const heading = (level, value) => ({ type: 'HEADING', id: nodeId(), nodes: [text(value)], headingData: { level } });
const listItem = (value) => ({ type: 'LIST_ITEM', id: nodeId(), nodes: [paragraph(text(value))], listItemData: {} });
const bulletedList = (...values) => ({ type: 'BULLETED_LIST', id: nodeId(), nodes: values.map(listItem), bulletedListData: {} });
const orderedList = (...values) => ({ type: 'ORDERED_LIST', id: nodeId(), nodes: values.map(listItem), numberedListData: {} });
const codeBlock = (value) => ({ type: 'CODE_BLOCK', id: nodeId(), nodes: [text(value)], codeBlockData: {} });
const blockquote = (value) => ({ type: 'BLOCKQUOTE', id: nodeId(), nodes: [paragraph(text(value))], quoteData: { indentation: 1 } });
const divider = () => ({ type: 'DIVIDER', id: nodeId(), dividerData: { lineStyle: 'SINGLE', width: 'LARGE', alignment: 'CENTER' } });
const image = (mediaId, url, width, height, altText) => ({
  type: 'IMAGE',
  id: nodeId(),
  nodes: [],
  imageData: { containerData: { width: { size: 'ORIGINAL' }, alignment: 'CENTER' }, image: { src: { id: mediaId, url }, width, height }, altText },
});
const doc = (...nodes) => ({ nodes, documentStyle: {} });

const BOLD = [{ type: 'BOLD', fontWeightValue: 700 }];
const ITALIC = [{ type: 'ITALIC', italicData: true }];
const UNDERLINE = [{ type: 'UNDERLINE', underlineData: true }];
const STRIKETHROUGH = [{ type: 'STRIKETHROUGH', strikethroughData: true }];
// NOTE: Wix's API validates `target` against the enum [SELF, BLANK, PARENT, TOP]. The repo's
// rich-content types declare '_blank' | '_self' (HTML attribute values), which Wix rejects.
const link = (url) => [{ type: 'LINK', linkData: { link: { url, target: 'BLANK' } } }];

// ── torture strings ─────────────────────────────────────────────────────────
const UNICODE_SOUP = 'emoji 🥺🎉👨‍👩‍👧‍👦 · CJK 日本語テスト漢字 · RTL مرحبا بالعالم · ZWSP a​b · quotes "double" \'single\' · entity &amp;&lt;p&gt; · backslash \\ · tab\tand newline';
const LONG_2001 = 'A'.repeat(2000) + 'B'; // one past the common 2000-char destination cap
const LONG_4200 = ('Lorem ipsum dolor sit amet, consectetur adipiscing elit. ').repeat(76); // ~4256 chars
const TITLE_200 = ('T200 ' + 'x'.repeat(300)).slice(0, 200);
const EXCERPT_500 = ('E500 ' + 'y'.repeat(600)).slice(0, 500);
const DANGLING_GUID = '00000000-0000-4000-8000-000000000abc';

// ── categories + tags (FK targets) ──────────────────────────────────────────
async function ensureCategories(labels) {
  const existing = (await wix('GET', '/blog/v3/categories?paging.limit=100')).categories ?? [];
  const byLabel = new Map(existing.map((c) => [c.label, c.id]));
  const ids = [];
  for (const label of labels) {
    if (byLabel.has(label)) { ids.push(byLabel.get(label)); continue; }
    const created = await wix('POST', '/blog/v3/categories', { category: { label } });
    log('created category', label, created.category?.id);
    ids.push(created.category?.id);
  }
  return ids;
}

async function ensureTags(labels) {
  const existing = (await wix('GET', '/blog/v3/tags?paging.limit=100')).tags ?? [];
  const byLabel = new Map(existing.map((t) => [t.label, t.id]));
  const ids = [];
  for (const label of labels) {
    if (byLabel.has(label)) { ids.push(byLabel.get(label)); continue; }
    // Note: unlike categories, the Create Tag endpoint takes a FLAT body — a { tag: { label } }
    // envelope is accepted but silently reads label as empty and 400s.
    const created = await wix('POST', '/blog/v3/tags', { label });
    log('created tag', label, created.tag?.id);
    ids.push(created.tag?.id);
  }
  return ids;
}

// ── existing posts (for idempotency) ────────────────────────────────────────
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

const existingPosts = await listAllDraftPosts();
const postIdByTitle = new Map(existingPosts.map((p) => [p.title, p.id]));
log(`site currently has ${existingPosts.length} draft posts`);

/**
 * Wix rejects Create Draft Post with "Missing post owner information" unless a `memberId` is
 * supplied, so every seeded post is attributed to the site's first blog member.
 */
const seedOwnerMemberId = (await wix('GET', '/members/v1/members?paging.limit=1')).members?.[0]?.id;
if (!seedOwnerMemberId) throw new Error('No blog member found on this Wix site — cannot create draft posts');
log('seeding as memberId', seedOwnerMemberId);

async function upsertPost(postWithoutOwner) {
  const post = { memberId: seedOwnerMemberId, ...postWithoutOwner };
  const existingId = postIdByTitle.get(post.title);
  if (existingId) {
    const updated = await wix('PATCH', `/blog/v3/draft-posts/${existingId}?fieldsets=RICH_CONTENT`, { draftPost: post });
    return updated.draftPost;
  }
  const created = await wix('POST', '/blog/v3/draft-posts?fieldsets=RICH_CONTENT', { draftPost: post });
  postIdByTitle.set(post.title, created.draftPost?.id);
  return created.draftPost;
}

const categoryIds = await ensureCategories([`${PREFIX} cat alpha`, `${PREFIX} cat "quoted, comma"`, `${PREFIX} cat 日本語`]);
const tagIds = await ensureTags([`${PREFIX} tag one`, `${PREFIX} tag two`, `${PREFIX} tag 🥺`]);
log('categoryIds', categoryIds, 'tagIds', tagIds);

// ── the torture records ─────────────────────────────────────────────────────
// Ordered so the self-referencing relatedPostIds record can point at earlier ones.
const seeded = {};

const specs = [
  // 1. all-empty / minimal — Wix requires a title, nothing else is set.
  { key: 'minimal', post: { title: `${PREFIX} 01 minimal` } },

  // 2. unicode + control characters everywhere they are accepted.
  {
    key: 'unicode',
    post: {
      title: `${PREFIX} 02 unicode ${UNICODE_SOUP}`.slice(0, 200),
      excerpt: UNICODE_SOUP,
      seoSlug: `${PREFIX}-02-unicode`,
      richContent: doc(paragraph(text(UNICODE_SOUP)), paragraph(text('line1\nline2\ttabbed'))),
    },
  },

  // 3. long text past the 2000 and 4000 char destination caps.
  {
    key: 'longtext',
    post: {
      title: `${PREFIX} 03 longtext`,
      excerpt: EXCERPT_500,
      richContent: doc(paragraph(text(LONG_2001)), paragraph(text(LONG_4200))),
    },
  },

  // 4. boundary values at Wix's own documented caps.
  { key: 'boundary', post: { title: TITLE_200, excerpt: EXCERPT_500, seoSlug: (`${PREFIX}-04-` + 'b'.repeat(100)).slice(0, 100) } },

  // 5. full rich-content surface.
  {
    key: 'richtext',
    post: {
      title: `${PREFIX} 05 richtext`,
      excerpt: 'Every Ricos node kind our converters claim to handle.',
      richContent: doc(
        heading(1, 'Heading level 1'),
        heading(2, 'Heading level 2'),
        paragraph(text('plain '), text('bold', BOLD), text(' '), text('italic', ITALIC), text(' '), text('underline', UNDERLINE), text(' '), text('struck', STRIKETHROUGH)),
        paragraph(text('a link to '), text('example.com', link('https://example.com/a?b=c&d=e'))),
        bulletedList('bullet one', 'bullet two', 'bullet three'),
        orderedList('ordered one', 'ordered two'),
        codeBlock('const x = {"a": 1};\nif (x) { return `<b>${x}</b>`; }'),
        blockquote('A quoted claim.'),
        divider(),
        image('9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg', 'https://static.wixstatic.com/media/9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg', 1200, 800, 'QA alt text'),
      ),
    },
  },

  // 6/7/8. arrays at 0, 1 and 3+ elements; elements with commas and quotes.
  { key: 'arrays_zero', post: { title: `${PREFIX} 06 arrays zero`, hashtags: [], categoryIds: [], tagIds: [], relatedPostIds: [], pricingPlanIds: [] } },
  { key: 'arrays_one', post: { title: `${PREFIX} 07 arrays one`, hashtags: ['solo'], categoryIds: [categoryIds[0]], tagIds: [tagIds[0]] } },
  {
    key: 'arrays_many',
    post: {
      title: `${PREFIX} 08 arrays many`,
      hashtags: ['first', 'has,comma', 'has"quote"', 'CJK日本語', '🥺emoji'],
      categoryIds,
      tagIds,
    },
  },

  // 9. booleans + language + seo settings all set to the non-default value.
  {
    key: 'flags',
    post: {
      title: `${PREFIX} 09 flags`,
      excerpt: 'featured on, commenting off, non-default language',
      featured: true,
      commentingEnabled: false,
      language: 'fr',
      seoSlug: `${PREFIX}-09-flags`,
      seoData: { tags: [{ type: 'title', children: 'QA SEO title' }, { type: 'meta', props: { name: 'description', content: 'QA SEO description' } }], settings: { preventAutoRedirect: true, keywords: [] } },
    },
  },

  // 10. hero image — the schema models this as an object; the SDK types it as a string.
  //     Seed the object shape the schema declares so pull can be compared against it.
  {
    key: 'heroimage',
    post: {
      title: `${PREFIX} 10 heroimage`,
      media: {
        wixMedia: { image: { id: '9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg', url: 'https://static.wixstatic.com/media/9a4116_2161bd3b120046b7bc653b638305c2cc~mv2.jpg', height: 800, width: 1200 } },
        displayed: true,
        custom: true,
      },
    },
  },

  // 11. a foreign key pointing at a record that is NOT in the export.
  { key: 'dangling_fk', post: { title: `${PREFIX} 11 dangling fk`, pricingPlanIds: [DANGLING_GUID] } },
];

for (const spec of specs) {
  const result = await upsertPost(spec.post);
  seeded[spec.key] = result?.id;
  log('upserted', spec.post.title.slice(0, 60), '→', result?.id);
}

// 12. self-referencing FK at Wix's documented max of 3 related posts, pointing at
//     records that ARE in the export.
const relatedTargets = [seeded.minimal, seeded.unicode, seeded.longtext].filter(Boolean);
const related = await upsertPost({ title: `${PREFIX} 12 related posts`, relatedPostIds: relatedTargets });
seeded.related = related?.id;
log('upserted related-posts record →', related?.id, 'pointing at', relatedTargets.length);

// ── bulk records to force offset pagination past the 100-per-page boundary ───
if (BULK_COUNT > 0) {
  const needed = [];
  for (let i = 1; i <= BULK_COUNT; i++) {
    const title = `${PREFIX} bulk ${String(i).padStart(4, '0')}`;
    if (!postIdByTitle.has(title)) needed.push({ title, memberId: seedOwnerMemberId, excerpt: `bulk record ${i} of ${BULK_COUNT}`, richContent: doc(paragraph(text(`Body of bulk record ${i}.`))) });
  }
  log(`bulk: ${BULK_COUNT} requested, ${needed.length} missing`);
  for (let i = 0; i < needed.length; i++) {
    const created = await wix('POST', '/blog/v3/draft-posts', { draftPost: needed[i] });
    postIdByTitle.set(needed[i].title, created.draftPost?.id);
    if ((i + 1) % 25 === 0) log(`  bulk ${i + 1}/${needed.length}`);
  }
}

const finalPosts = await listAllDraftPosts();
log(`DONE — site now has ${finalPosts.length} draft posts`);
console.log(JSON.stringify({ seeded, categoryIds, tagIds, totalDraftPosts: finalPosts.length }, null, 1));
