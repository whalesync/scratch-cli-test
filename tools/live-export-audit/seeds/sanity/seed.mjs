#!/usr/bin/env node
/**
 * Idempotent torture-data seeder for the SANITY Live Export audit.
 *
 * Seeds `fable_qa_author` / `fable_qa_post` document types (plus filler posts for
 * pagination) into the audit project via the Mutation API. Every document uses
 * `createOrReplace` with a fixed `_id`, so re-running updates instead of duplicating.
 *
 * Reads the token from local/audit-creds/sanity.env (apiKey=...). Project/dataset are
 * fixed to the audit project. Run: node tools/live-export-audit/seeds/sanity/seed.mjs
 * Cleanup: pass --delete to remove every fable_qa_* document.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ID = 'hkcx2dra';
const DATASET = 'production';
const API_VERSION = 'v2025-02-19';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const credsFileText = readFileSync(join(repoRoot, 'local', 'audit-creds', 'sanity.env'), 'utf8');
const apiToken = credsFileText
  .split('\n')
  .filter((line) => !line.startsWith('#'))
  .find((line) => line.startsWith('apiKey='))
  ?.slice('apiKey='.length)
  .trim();
if (!apiToken) throw new Error('No apiKey= line in local/audit-creds/sanity.env');

async function mutate(mutations) {
  const response = await fetch(`https://${PROJECT_ID}.api.sanity.io/${API_VERSION}/data/mutate/${DATASET}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutations }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`mutate -> ${response.status}: ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

async function groq(query) {
  const response = await fetch(
    `https://${PROJECT_ID}.api.sanity.io/${API_VERSION}/data/query/${DATASET}?query=${encodeURIComponent(query)}`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  const body = await response.json();
  if (!response.ok) throw new Error(`query -> ${response.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return body.result;
}

if (process.argv.includes('--delete')) {
  const ids = await groq('*[_type in ["fable_qa_author", "fable_qa_post", "fable_qa_orphan"]]._id');
  for (let i = 0; i < ids.length; i += 100) {
    await mutate(ids.slice(i, i + 100).map((id) => ({ delete: { id } })));
  }
  console.log(`deleted ${ids.length} fable_qa_* documents`);
  process.exit(0);
}

const exactly = (n, tail) => 'x'.repeat(n - tail.length) + tail;

const authors = [
  {
    _id: 'fable-qa-author-full',
    _type: 'fable_qa_author',
    name: 'Fable QA Author — 完全 🎯 مرحبا',
    email: 'fable-qa@example.com',
    website: 'https://example.com/fable-qa?a=1&b="quoted"',
    active: true,
    joinedAt: '2026-01-02T03:04:05.678Z',
    slug: { _type: 'slug', current: 'fable-qa-author-full' },
    address: { street: '99 Torture Ave', city: 'Sydney', 'zip-code': '2000' },
    location: { _type: 'geopoint', lat: -33.8688, lng: 151.2093 },
    favoritePost: { _type: 'reference', _ref: 'fable-qa-post-torture' },
  },
  {
    _id: 'fable-qa-author-empty',
    _type: 'fable_qa_author',
    name: null,
    email: '',
    active: null,
  },
];

const tortureBody = [
  { _type: 'block', _key: 'h', style: 'h2', markDefs: [], children: [{ _type: 'span', _key: 'h1', text: 'Heading two', marks: [] }] },
  {
    _type: 'block',
    _key: 'p1',
    style: 'normal',
    markDefs: [{ _key: 'lnk', _type: 'link', href: 'https://example.com/x?y=1&z=2' }],
    children: [
      { _type: 'span', _key: 's1', text: 'Bold', marks: ['strong'] },
      { _type: 'span', _key: 's2', text: ' italic', marks: ['em'] },
      { _type: 'span', _key: 's3', text: ' linked', marks: ['lnk'] },
      { _type: 'span', _key: 's4', text: ' plain with\nnewline', marks: [] },
    ],
  },
  { _type: 'block', _key: 'l1', style: 'normal', listItem: 'bullet', level: 1, markDefs: [], children: [{ _type: 'span', _key: 'li1', text: 'bullet one', marks: [] }] },
  { _type: 'block', _key: 'l2', style: 'normal', listItem: 'number', level: 1, markDefs: [], children: [{ _type: 'span', _key: 'li2', text: 'number one', marks: [] }] },
  { _type: 'code', _key: 'cb', language: 'javascript', code: 'const answer = 42; // <script>"quotes"&entities</script>' },
  // Weak: no real uploaded asset in the audit project — doubles as the dangling-asset case.
  { _type: 'image', _key: 'img', asset: { _type: 'reference', _ref: 'image-nonexistent-100x100-png', _weak: true } },
];

const posts = [
  {
    _id: 'fable-qa-post-torture',
    _type: 'fable_qa_post',
    title: 'Torture ☂️ 中文 עברית ​zero-width "quotes" <b>&amp;</b>\ttab',
    slug: { _type: 'slug', current: 'fable-qa-post-torture' },
    publishedAt: '2026-06-15T12:34:56.789Z',
    dateOnly: '2026-06-15',
    extremePast: '0100-01-01T00:00:00Z',
    extremeFuture: '9999-12-31T23:59:59Z',
    countZero: 0,
    countNegative: -273,
    bigInteger: 9007199254740993,
    preciseDecimal: 0.1234567890123456,
    percentLike: 0.875,
    featured: true,
    longText2001: exactly(2001, ' END-2001'),
    longText4001: exactly(4001, ' END-4001'),
    tagsEmpty: [],
    tagsOne: ['solo'],
    tagsMany: ['alpha, with comma', 'beta "quoted"', 'gamma', 'δέλτα'],
    author: { _type: 'reference', _ref: 'fable-qa-author-full' },
    coAuthors: [
      { _type: 'reference', _ref: 'fable-qa-author-full', _key: 'ca1' },
      { _type: 'reference', _ref: 'fable-qa-author-empty', _key: 'ca2' },
    ],
    // Sanity enforces referential integrity on STRONG refs (409 on dangling), so the
    // "link to a record outside the export" case is two-pronged: a WEAK ref to a truly
    // nonexistent id, and a strong ref to a real doc whose type is NOT in the export.
    missingRef: { _type: 'reference', _ref: 'fable-qa-not-exported-anywhere', _weak: true },
    orphanTypeRef: { _type: 'reference', _ref: 'fable-qa-orphan-1' },
    seo: { metaTitle: 'Torture SEO', metaDescription: exactly(2100, ' META-END') },
    body: tortureBody,
  },
  {
    _id: 'fable-qa-post-empty',
    _type: 'fable_qa_post',
    title: null,
  },
];

for (let fillerIndex = 1; fillerIndex <= 210; fillerIndex++) {
  posts.push({
    _id: `fable-qa-post-filler-${String(fillerIndex).padStart(3, '0')}`,
    _type: 'fable_qa_post',
    title: `Filler post ${fillerIndex}`,
    publishedAt: `2026-05-${String((fillerIndex % 28) + 1).padStart(2, '0')}T08:00:00Z`,
    countZero: fillerIndex,
    featured: fillerIndex % 2 === 0,
    author: { _type: 'reference', _ref: 'fable-qa-author-full' },
  });
}

const orphanDocuments = [
  // Type deliberately excluded from the export — the strong `orphanTypeRef` above points here.
  { _id: 'fable-qa-orphan-1', _type: 'fable_qa_orphan', label: 'Not exported' },
];

const allDocuments = [...orphanDocuments, ...authors, ...posts];
for (let i = 0; i < allDocuments.length; i += 50) {
  await mutate(allDocuments.slice(i, i + 50).map((doc) => ({ createOrReplace: doc })));
}
const counts = await groq('{"authors": count(*[_type=="fable_qa_author"]), "posts": count(*[_type=="fable_qa_post"])}');
console.log('seeded:', JSON.stringify(counts));
if (counts.authors !== 2 || counts.posts !== 212) throw new Error('unexpected seed counts');
console.log('read-back verification OK');
