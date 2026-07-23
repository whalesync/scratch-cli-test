#!/usr/bin/env node
/**
 * Live Export source-service audit harness.
 *
 * Drives a source → destination Live Export end-to-end through the SAME server flow the
 * dusky wizard uses (connections → data folders → pull → plan-from-folder → sync-draft →
 * save → routine trigger → publish), and emits a machine-readable report.json that the
 * /test-live-export skill interprets.
 *
 * Faithfulness is the point: request bodies mirror what dusky sends (FK targets keep
 * `unresolvedLinkedTableId`; the server binds them at save), and when @spinner/shared-types
 * is resolvable the bodies are validated against its zod schemas before sending — so a
 * finding is a product bug, not a harness artifact.
 *
 * Usage:
 *   node tools/live-export-audit/audit.mjs --source AIRTABLE --dest NOTION [options]
 *
 * Options:
 *   --source SERVICE            source connector service enum (AIRTABLE, HUBSPOT, ...)
 *   --dest SERVICE              destination connector service enum
 *   --tables a,b                remote table ids (joined with "/" for compound ids, e.g.
 *                               "public/my_table" or "appXXX/tblYYY"); default: first
 *                               --max-tables tables the connector lists
 *   --max-tables N              cap on auto-selected tables (default 6)
 *   --workbook wkb_x            reuse an existing workbook (resume / OAuth flows)
 *   --source-connection coa_x   reuse an existing connection (REQUIRED for OAuth-only sources)
 *   --dest-connection coa_x     reuse an existing destination connection
 *   --dest-parent id            create-destination parent (e.g. Notion page id); default:
 *                               DEST_PARENT_ID from the dest creds file, else first listed
 *   --skip-fields "A,B"         destination field names to leave unselected
 *   --report path               where to write report.json (default ./live-export-audit-report.json)
 *   --rerun                     skip setup, just trigger the routine again and report
 *                               (requires --workbook; used for CRUD verification passes)
 *   --second-run-check          after the first run completes, run again with no source
 *                               changes and record whether it was a no-op
 *   --no-run                    stop after save (schema/plan audit only)
 *
 * Credentials come from gitignored env files — see resolveCreds() and the README.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// ── args ─────────────────────────────────────────────────────────────────────
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
const SOURCE = (args.source || '').toUpperCase();
const DEST = (args.dest || '').toUpperCase();
if (!SOURCE || !DEST) fail('Both --source and --dest are required, e.g. --source AIRTABLE --dest NOTION');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CREDS_DIR = path.join(REPO_ROOT, 'local/audit-creds');
const REPORT_PATH = args.report || 'live-export-audit-report.json';
const MAX_TABLES = Number(args['max-tables'] || 6);

function fail(msg) {
  console.error(`\nPREFLIGHT FAILED: ${msg}\n`);
  process.exit(1);
}
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

// ── creds + preflight ────────────────────────────────────────────────────────
function readEnvFile(file) {
  if (!fs.existsSync(file)) return null;
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const spinnerEnv = readEnvFile(path.join(CREDS_DIR, '_spinner.env')) || {};
const BASE = process.env.SPINNER_API_URL || spinnerEnv.SPINNER_API_URL || 'http://localhost:3010';
const TOKEN = process.env.SPINNER_API_TOKEN || spinnerEnv.SPINNER_API_TOKEN;

async function api(method, p, body, opts = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: `API-Token ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok && !opts.allowFail) {
    throw new Error(`${method} ${p} -> ${res.status}: ${text.slice(0, 1500)}`);
  }
  return { status: res.status, ok: res.ok, body: json };
}

/**
 * Optional request-shape validation against the real zod schemas. Best-effort:
 * resolved out of server/node_modules so the harness itself stays dependency-free.
 */
let schemas = null;
try {
  const req = createRequire(path.join(REPO_ROOT, 'server/package.json'));
  const st = req('@spinner/shared-types');
  schemas = {
    patchSyncDraft: st.patchSyncDraftSchema,
    generateCreatePlan: st.generateCreatePlanSchema,
    createConnectorAccount: st.createConnectorAccountSchema,
  };
} catch {
  log('WARN: could not resolve @spinner/shared-types — request-shape validation disabled');
}
function validate(name, body) {
  const schema = schemas?.[name];
  if (!schema?.safeParse) return;
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new Error(
      `Harness bug: ${name} request body fails ${name}Schema validation — fix the harness, ` +
        `do NOT file this as a product issue.\n${JSON.stringify(r.error.issues, null, 1).slice(0, 2000)}`,
    );
  }
}

async function preflight() {
  const problems = [];

  // 1. Server up?
  try {
    const h = await fetch(`${BASE}/health`).then((r) => r.json());
    if (h.status !== 'alive') problems.push(`Server at ${BASE} responded but not healthy: ${JSON.stringify(h)}`);
  } catch {
    problems.push(`No spinner server at ${BASE}. Start the local stack (server on :3010) or set SPINNER_API_URL.`);
  }

  // 2. Token?
  if (!TOKEN) {
    problems.push(
      `No SPINNER_API_TOKEN. Put it in ${CREDS_DIR}/_spinner.env (SPINNER_API_TOKEN=...). ` +
        `Mint one with POST ${BASE}/users/current/api-token from an authed session, or read an ` +
        `existing USER token from the local scratchpaper DB ("APIToken" table).`,
    );
  } else {
    const me = await api('GET', '/users/current', undefined, { allowFail: true });
    if (!me.ok) problems.push(`SPINNER_API_TOKEN rejected (${me.status}). Re-mint it.`);
  }

  // 3. Connector metadata — tells us each service's credential fields and whether API-key auth exists.
  let metadata = null;
  try {
    metadata = (await api('GET', '/connectors/metadata')).body;
  } catch (e) {
    problems.push(`Could not fetch /connectors/metadata: ${e.message}`);
  }

  const credsPlan = {};
  for (const [role, service, connFlag] of [
    ['source', SOURCE, args['source-connection']],
    ['dest', DEST, args['dest-connection']],
  ]) {
    if (connFlag) { credsPlan[role] = { connectionId: connFlag }; continue; }
    // /connectors/metadata returns a map keyed by service enum.
    const meta = metadata?.[service] ?? null;
    if (metadata !== null && !meta) {
      problems.push(`Unknown service "${service}" — not present in /connectors/metadata. Check the enum spelling.`);
      continue;
    }
    const supportsUserParams = (meta?.supportedAuthMethods ?? []).includes('user_provided_params');
    const credFields = supportsUserParams ? (meta?.credentialFields?.user_provided_params ?? []) : null;
    const envFile = path.join(CREDS_DIR, `${service.toLowerCase()}.env`);
    const env = readEnvFile(envFile);
    if (env && Object.keys(env).length > 0) {
      credsPlan[role] = { params: env };
    } else if (metadata === null) {
      problems.push(`Missing credentials for ${service} (create ${envFile}) — could not fetch /connectors/metadata to list its required fields.`);
    } else if (credFields === null) {
      problems.push(
        `${service} appears to be OAuth-only (no user-provided credential fields). Connect it once ` +
          `through the dusky UI (localhost:3030/exports → new export → connect ${service}), then pass ` +
          `--workbook <wkb_...> --${role}-connection <coa_...> to adopt that connection.`,
      );
    } else {
      const fieldNames = (Array.isArray(credFields) ? credFields : []).map((f) => f.key ?? f.name ?? JSON.stringify(f));
      problems.push(
        `Missing credentials for ${service}. Create ${envFile} with KEY=VALUE lines named after its ` +
          `userProvidedParams${fieldNames.length ? `: ${fieldNames.join(', ')}` : ' (see /connectors/metadata)'}. ` +
          `Use a BURNER account — this harness creates, edits, and deletes real records.`,
    );
    }
  }

  if (problems.length > 0) {
    console.error('\n══ PREFLIGHT CHECKLIST — fix these, then re-run ══');
    for (const p of problems) console.error(` ✗ ${p}`);
    console.error('');
    process.exit(1);
  }
  log('preflight OK');
  return credsPlan;
}

// ── job/run polling ──────────────────────────────────────────────────────────
async function pollJob(jobId, label, timeoutMs = 900_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api('GET', `/jobs/${jobId}/progress`);
    if (body.state === 'completed' || body.state === 'failed') return body;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`job ${jobId} (${label}) timed out after ${timeoutMs}ms`);
}

async function pollRoutineRun(workbookId, runId, timeoutMs = 1_800_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { body } = await api('GET', `/workbooks/${workbookId}/routine-runs/${runId}?includeJobs=true`);
    if (!['pending', 'running'].includes(body.status)) return body;
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`routine run ${runId} timed out`);
}

function publishSummary(run) {
  const out = { status: run.status, resultSummary: run.resultSummary, resultWarning: run.resultWarning, steps: [] };
  for (const s of run.steps ?? []) {
    const pp = s.job?.publicProgress ?? {};
    const step = { action: s.action, status: s.status, summary: s.result?.summary ?? null };
    if (s.action === 'publish') {
      step.publish = {
        createsPlanned: pp.createsPlanned ?? null,
        createsExecuted: pp.createsExecuted ?? null,
        editsPlanned: pp.editsPlanned ?? null,
        editsExecuted: pp.editsExecuted ?? null,
        deletesPlanned: pp.deletesPlanned ?? null,
        deletesExecuted: pp.deletesExecuted ?? null,
        failedCount: pp.failedCount ?? 0,
        failedOperations: pp.failedOperations ?? [],
      };
    }
    if (s.action === 'sync') step.tables = (pp.tables ?? []).map((t) => ({ name: t.name, creates: t.creates, updates: t.updates, deletes: t.deletes, errorCount: t.errorCount, warnings: t.warnings }));
    out.steps.push(step);
  }
  return out;
}

async function triggerRoutine(workbookId, syncId) {
  const routines = (await api('GET', `/workbooks/${workbookId}/routines`)).body;
  const list = routines.routines ?? routines;
  const routine = list.find((r) => (r.filePath || '').includes(syncId)) ?? list[0];
  if (!routine) throw new Error('no routine found for sync ' + syncId);
  const run = await api('POST', `/workbooks/${workbookId}/routines/trigger`, { filePath: routine.filePath });
  log('routine run', run.body.id);
  return pollRoutineRun(workbookId, run.body.id);
}

// ── main flow ────────────────────────────────────────────────────────────────
const report = {
  meta: { source: SOURCE, dest: DEST, base: BASE, startedAt: new Date().toISOString(), argv: process.argv.slice(2) },
  connections: {},
  tables: [],
  save: null,
  runs: [],
  secondRunCheck: null,
};

const credsPlan = await preflight();

// Workbook
let wb = args.workbook;
if (!wb) {
  wb = (await api('POST', '/workbook', { name: `QA ${SOURCE} → ${DEST}` })).body.id;
}
report.meta.workbookId = wb;
log('workbook', wb);

// ── rerun-only mode (CRUD verification passes) ──────────────────────────────
if (args.rerun) {
  if (!args.workbook) fail('--rerun requires --workbook');
  const syncs = (await api('GET', `/workbooks/${wb}/syncs`)).body;
  const sync = syncs[syncs.length - 1];
  if (!sync) fail('no sync on that workbook');
  const run = await triggerRoutine(wb, sync.id);
  report.runs.push(publishSummary(run));
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1));
  console.log(JSON.stringify(publishSummary(run), null, 1));
  process.exit(0);
}

// Connections
async function ensureConnection(role, service, plan) {
  if (plan.connectionId) {
    const conn = (await api('GET', `/workbooks/${wb}/connections/${plan.connectionId}`)).body;
    log(`conn ${role} ${service} (reused)`, conn.id);
    return conn.id;
  }
  const body = { service, authType: 'API_KEY', userProvidedParams: plan.params, displayName: `qa-${role}-${service}` };
  validate('createConnectorAccount', body);
  const conn = (await api('POST', `/workbooks/${wb}/connections`, body)).body;
  const test = await api('POST', `/workbooks/${wb}/connections/${conn.id}/test`, {}, { allowFail: true });
  report.connections[role] = { id: conn.id, service, test: test.body };
  if (test.body?.health !== 'ok') {
    fail(`${role} connection test failed for ${service}: ${JSON.stringify(test.body).slice(0, 400)}`);
  }
  log(`conn ${role} ${service}`, conn.id, 'health ok');
  return conn.id;
}
const srcConn = await ensureConnection('source', SOURCE, credsPlan.source ?? {});
const dstConn = await ensureConnection('dest', DEST, credsPlan.dest ?? {});

// Destination parent (where new tables are created)
let destParent = args['dest-parent'] || credsPlan.dest?.params?.DEST_PARENT_ID || null;
if (!destParent) {
  const resp = (await api('GET', `/workbooks/${wb}/connections/${dstConn}/create-destinations`, undefined, { allowFail: true })).body;
  const dests = resp?.destinations ?? resp?.createDestinations ?? (Array.isArray(resp) ? resp : []);
  if (dests.length > 0) {
    destParent = Array.isArray(dests[0].id) ? dests[0].id[0] : dests[0].id;
    log('dest parent (auto-picked first):', destParent, `(${dests[0].name ?? '?'})`);
  }
}
report.meta.destParent = destParent;

// Table selection
const tablesResp = (await api('GET', `/workbooks/${wb}/connections/${srcConn}/tables`)).body;
const allTables = (tablesResp.tables ?? tablesResp).map((t) => ({
  remoteId: t.id?.remoteId ?? t.remoteId,
  name: t.displayName ?? t.name,
}));
let selected;
if (args.tables) {
  selected = String(args.tables).split(',').map((spec) => {
    const remoteId = spec.split('/');
    const match = allTables.find((t) => JSON.stringify(t.remoteId) === JSON.stringify(remoteId) || t.remoteId?.includes(spec) || t.name === spec);
    return match ?? { remoteId, name: spec };
  });
} else {
  selected = allTables.slice(0, MAX_TABLES);
  if (allTables.length > MAX_TABLES) log(`NOTE: ${allTables.length} tables available, auto-capped to ${MAX_TABLES}. Pass --tables to target.`);
}
report.meta.availableTables = allTables.map((t) => t.name);
log('tables:', selected.map((t) => t.name).join(', '));

// Data folders + pull
const folders = [];
for (const t of selected) {
  const { body } = await api('POST', '/data-folder/create', {
    name: t.name, workbookId: wb, connectorAccountId: srcConn, tableId: t.remoteId, triggerPull: false,
  });
  folders.push({ ...t, dataFolderId: body.id });
}
const pull = await api('POST', `/workbook/${wb}/pull-files`, { dataFolderIds: folders.map((f) => f.dataFolderId) });
if (pull.body.jobId) {
  const pullResult = await pollJob(pull.body.jobId, 'pull');
  if (pullResult.state === 'failed') {
    report.pullFailure = pullResult;
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1));
    fail(`source pull failed: ${pullResult.failedReason ?? JSON.stringify(pullResult).slice(0, 500)}`);
  }
}
log('pull complete');

// Sample values per folder — the raw material for judging downgraded fields.
async function sampleFolder(dataFolderId, maxFiles = 8) {
  const listing = (await api('GET', `/workbooks/${wb}/files/list/by-folder?folderId=${dataFolderId}&limit=${maxFiles}`, undefined, { allowFail: true })).body;
  const items = (listing.items ?? listing.files ?? []).filter((i) => i.type === 'file' && !i.name.startsWith('scratch_pending'));
  const samples = {};
  let count = 0;
  for (const item of items.slice(0, maxFiles)) {
    const f = (await api('GET', `/workbooks/${wb}/files/by-path?path=${encodeURIComponent(item.path)}`, undefined, { allowFail: true })).body;
    let content;
    try { content = JSON.parse(f.file?.content ?? '{}'); } catch { continue; }
    count++;
    const flatten = (obj, prefix) => {
      for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        (samples[key] ??= []).length < 5 && samples[key].push(v === null ? null : v);
        if (v && typeof v === 'object' && !Array.isArray(v) && prefix === undefined) flatten(v, key);
      }
    };
    flatten(content, undefined);
  }
  return { fileCount: count, samples };
}

// Plan per folder + assemble draft mappings (dusky-faithful: FK targets keep
// unresolvedLinkedTableId; the server resolves them against the draft at save).
const draft = (await api('POST', `/workbooks/${wb}/sync-drafts`, {})).body;
const skipFields = new Set(String(args['skip-fields'] ?? '').split(',').filter(Boolean));
const selectedRemoteLeafIds = new Set(folders.flatMap((f) => f.remoteId));
const tableMappings = [];

for (const f of folders) {
  const planBody = { sources: [{ dataFolderId: f.dataFolderId }], destinationConnectorAccountId: dstConn };
  validate('generateCreatePlan', planBody);
  const plan = (await api('POST', `/workbook/${wb}/schema/plan-from-folder`, planBody)).body;
  const spec = plan.plan.tables.find((t) => t.ref === f.dataFolderId) ?? plan.plan.tables[0];

  const tableReport = {
    name: f.name,
    remoteId: f.remoteId,
    dataFolderId: f.dataFolderId,
    prerequisites: plan.prerequisites ?? null,
    fields: spec.fields.map((fl) => ({ name: fl.name, kind: fl.fieldType.kind, isPrimary: !!fl.isPrimary, isSourceRecordId: !!fl.isSourceRecordId })),
    notes: plan.notes.map((n) => ({ field: n.fieldName, sourcePath: n.sourceFieldPath, status: n.status, mappedKind: n.mappedKind, message: n.message ?? null })),
    droppedForeignKeys: [],
    ...(await sampleFolder(f.dataFolderId)),
  };
  report.tables.push(tableReport);

  let fields = spec.fields.filter((fl) => !skipFields.has(fl.name));
  fields = fields.flatMap((fl) => {
    if (fl.fieldType.kind !== 'foreignKey') return [fl];
    const tgt = fl.fieldType.target ?? {};
    if (tgt.existingRemoteTableId || tgt.ref) return [fl];
    const linked = tgt.unresolvedLinkedTableId;
    if (linked && (selectedRemoteLeafIds.has(linked) || folders.some((o) => o.remoteId?.includes(linked)))) return [fl];
    tableReport.droppedForeignKeys.push({ field: fl.name, linkedTableId: linked ?? null });
    return [];
  });
  const srcRecId = spec.fields.find((fl) => fl.isSourceRecordId);
  if (srcRecId && !fields.some((fl) => fl.isSourceRecordId)) fields.push(srcRecId);
  const primary = plan.prerequisites?.primaryField ? (fields.find((fl) => fl.isPrimary) ?? spec.fields.find((fl) => fl.isPrimary)) : undefined;
  if (primary && !fields.some((fl) => fl.name === primary.name)) fields.push(primary);

  const pathByName = new Map(plan.notes.map((n) => [n.fieldName, n.sourceFieldPath]));
  const columnMappings = fields.flatMap((fl) => {
    const columnId = pathByName.get(fl.name);
    return columnId ? [{ source: { columnId }, destination: { kind: 'placeholderField', ref: fl.name } }] : [];
  });
  const recIdCol = srcRecId ? pathByName.get(srcRecId.name) : undefined;

  tableMappings.push({
    ref: f.dataFolderId,
    source: { dataFolderId: f.dataFolderId },
    destination: {
      kind: 'placeholderTable',
      ref: f.dataFolderId,
      connectorAccountId: dstConn,
      ...(destParent ? { remoteParentId: [destParent] } : {}),
      createSpec: { ...spec, fields },
    },
    columnMappings,
    ...(srcRecId && recIdCol
      ? {
          recordMatching: { source: { columnId: recIdCol }, destination: { kind: 'placeholderField', ref: srcRecId.name } },
          unmatchedDestinationPolicy: { withMatchKey: 'delete', withoutMatchKey: 'ignore' },
        }
      : {}),
  });
}

// Patch + save
const fresh = (await api('GET', `/sync-drafts/${draft.id}`)).body;
const patchBody = { version: fresh.version, displayName: `QA ${SOURCE} → ${DEST}`, tableMappings };
validate('patchSyncDraft', patchBody);
await api('PATCH', `/sync-drafts/${draft.id}`, patchBody);
const save = await api('POST', `/sync-drafts/${draft.id}/save`, { createRoutine: true });
const saveResult = await pollJob(save.body.jobId, 'save');
report.save = { state: saveResult.state, failedReason: saveResult.failedReason ?? null, progress: saveResult.publicProgress ?? null };
if (saveResult.state === 'failed') {
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1));
  console.error('SAVE FAILED — schema/plan report still written to', REPORT_PATH);
  console.error(saveResult.failedReason);
  process.exit(2);
}
log('draft saved; sync', saveResult.publicProgress?.syncId);
report.meta.syncId = saveResult.publicProgress?.syncId;

if (args['no-run']) {
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1));
  console.log('Plan-only audit written to', REPORT_PATH);
  process.exit(0);
}

// Run + publish
const run1 = await triggerRoutine(wb, report.meta.syncId);
report.runs.push(publishSummary(run1));

// Optional steady-state check: a second run with no source changes should publish nothing.
if (args['second-run-check']) {
  const run2 = await triggerRoutine(wb, report.meta.syncId);
  const summary = publishSummary(run2);
  const publish = summary.steps.find((s) => s.action === 'publish')?.publish ?? {};
  const touched = (publish.createsExecuted ?? 0) + (publish.editsExecuted ?? 0) + (publish.deletesExecuted ?? 0);
  report.secondRunCheck = { ...summary, verdict: touched === 0 ? 'no-op (good)' : `NOT a no-op: ${touched} operations on unchanged data` };
  report.runs.push(summary);
}

fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 1));
log('report written to', REPORT_PATH);

// Console digest for the driving agent.
const digest = {
  workbookId: wb,
  syncId: report.meta.syncId,
  tables: report.tables.map((t) => ({
    name: t.name,
    records: t.fileCount,
    downgraded: t.notes.filter((n) => n.status !== 'mapped').map((n) => `${n.field}: ${n.message}`),
    droppedForeignKeys: t.droppedForeignKeys,
  })),
  firstRun: report.runs[0]?.resultSummary,
  publishFailures: report.runs[0]?.steps.find((s) => s.action === 'publish')?.publish?.failedOperations?.map((f) => f.error.slice(0, 200)) ?? [],
  secondRunCheck: report.secondRunCheck?.verdict ?? 'not requested',
};
console.log(JSON.stringify(digest, null, 1));
