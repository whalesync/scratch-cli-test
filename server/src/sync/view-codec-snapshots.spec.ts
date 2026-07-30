import type { TableView, TableViewCol, TransformerConfig } from '@spinner/shared-types';
import * as fs from 'fs';
import { get } from 'lodash';
import * as path from 'path';
import { AirtableConnector } from 'src/remote-service/connectors/library/airtable/airtable-connector';
import { FramerConnector } from 'src/remote-service/connectors/library/framer/framer-connector';
import { HubspotConnector } from 'src/remote-service/connectors/library/hubspot/hubspot-connector';
import { NotionConnector } from 'src/remote-service/connectors/library/notion/notion-connector';
import { PipedriveConnector } from 'src/remote-service/connectors/library/pipedrive/pipedrive-connector';
import { StripeConnector } from 'src/remote-service/connectors/library/stripe/stripe-connector';
import { WebflowConnector } from 'src/remote-service/connectors/library/webflow/webflow-connector';
import { WixBlogConnector } from 'src/remote-service/connectors/library/wix/wix-blog/wix-blog-connector';
import { Service } from 'src/remote-service/connectors/service-constants';
import type { BaseJsonTableSpec } from 'src/remote-service/connectors/types';
// Importing the transformers barrel registers every transformer implementation as a side effect,
// so `applyTransformerPipeline` can resolve `jsonpath` / `wrap_object` / … below.
import { applyTransformerPipeline, createNullLookupTools } from 'src/sync/transformers';
import type { PipelineBaseContext } from 'src/sync/transformers/transformer-pipeline';
import type { SyncRecord } from 'src/sync/transformers/transformer.types';
import { extractSchemaFields, type SchemaField } from 'src/utils/schema-helpers';
import { resolveColumnTransformInput } from './resolve-column-transform-input';

/**
 * VIEW CODEC GOLDENS — a targeted, real-data guardrail (Step 4 of the sync-transform-codec design).
 *
 * For each checked-in connector fixture (`__fixtures__/view-codec/<connector>-<table>/` = a real
 * `schema.json` spec wrapper + a few real `records/*.json`) this REGENERATES the connector's default View
 * from the spec — the pure MR2 `spec → view` stage, `connector.buildDefaultView(spec)`, invoked exactly as
 * a pull does — resolves every visible View column's codec the way a sync does
 * (`resolveColumnTransformInput`), and runs each record's value through it: `toCore` (extract → CORE value)
 * and, when the column declares a pack, the `fromCore` round-trip (CORE → native).
 *
 * OUTPUT IS SPLIT INTO SMALL PER-INPUT GOLDEN FILES (not one giant snapshot), stored as plain JSON under the
 * fixture's `__generated__/` dir so each file is readable and a diff points at exactly what changed:
 *   __generated__/view.json           — the regenerated default View. Moves iff view-gen changed.
 *   __generated__/columns.json        — each visible column's resolved codec (cardinality / logical +
 *                                       primitive type / toCore / fromCore). Moves iff view-gen or the
 *                                       resolver changed.
 *   __generated__/codec/<record>.json — ONE file per input record (SAME filename as `records/<record>`),
 *                                       holding `{ <columnId>: { core, roundTrip? } }`. Moves iff a
 *                                       transformer's output for that record changed.
 * No `view.json` is checked in as an INPUT — the view is derived from the spec every run, so it can never
 * drift from its generator, and view-gen itself is exercised on real data.
 *
 * These behave exactly like Jest snapshots (they honor `jest -u`), just stored as one plain-JSON file per
 * input instead of a single `.snap`:
 *   UPDATE:  `jest -u src/sync/view-codec-snapshots.spec.ts` (re)writes every golden and prunes goldens for
 *            deleted records; a normal run asserts against them and fails on drift.
 *   ADD RECORDS: drop a `*.json` into a fixture's `records/`, then `jest -u`.
 *   ADD A CONNECTOR/TABLE: add a `<connector>-<table>/` folder with `schema.json` + `records/`, register the
 *            connector slug in `DEFAULT_VIEW_BUILDERS_BY_CONNECTOR` below, then `jest -u`.
 */

const FIXTURES_DIR = path.join(__dirname, '__fixtures__', 'view-codec');
/** Sub-directory (per fixture) holding the regenerated goldens, kept separate from the checked-in inputs. */
const GENERATED_DIRNAME = '__generated__';

/** Cap long strings (signed asset URLs, rich-text bodies) so a golden stays readable + reviewable. */
function truncateForGolden(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.length > 200 ? `${value.slice(0, 180)}…«${value.length} chars»` : value;
  }
  if (Array.isArray(value)) return value.map(truncateForGolden);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, truncateForGolden(v)]));
  }
  return value;
}

/** The visible leaf columns of a View: banner groups expanded, hidden columns/groups dropped. */
function visibleColumns(view: TableView): TableViewCol[] {
  const cols: TableViewCol[] = [];
  for (const entry of view.cols) {
    if (entry.kind === 'banner-group') {
      if (!entry.hidden) cols.push(...entry.cols.filter((col) => !col.hidden));
    } else if (!entry.hidden) {
      cols.push(entry);
    }
  }
  return cols;
}

/** The JSON path a mapping references for this column — its selected subfield leaf, else the column root. */
function effectiveColumnId(col: TableViewCol): string {
  const selected = col.selectedSubfield !== undefined ? col.subfields?.[col.selectedSubfield] : undefined;
  return selected ? `${col.path}.${selected.relativePath}` : col.path;
}

function baseCtx(): PipelineBaseContext {
  const sourceRecord: SyncRecord = { id: 'fixture', filePath: '/fixture.json', fields: {} };
  return {
    sourceRecord,
    sourceFieldPath: 'value',
    sourceTableSpec: null,
    sourceService: Service.AIRTABLE,
    destinationFieldPath: 'value',
    destinationTableSpec: null,
    destinationService: Service.AIRTABLE,
    lookupTools: createNullLookupTools(),
    phase: 'DATA',
  };
}

/** Run a single codec transformer over a value; identity for no codec / a nullish value; a failed transform
 *  is captured (not thrown) so the golden SURFACES it rather than hiding a broken conversion. */
async function runCodec(transformer: TransformerConfig | undefined, value: unknown): Promise<unknown> {
  if (transformer === undefined || value === undefined || value === null) return value;
  const result = await applyTransformerPipeline([transformer], value, baseCtx());
  return result.success ? result.value : { __transformError: result.error };
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** The on-disk `schema.json` IS the table SPEC wrapper (`{ id, slug, name, schema, idPath, … }`) — exactly
 *  what `fetchJsonTableSpec` returns and what `buildDefaultView(spec)` consumes (the JSON schema lives under
 *  `.schema`). The fixture is plain JSON, so cast to the branded spec type. */
function loadSpec(file: string): BaseJsonTableSpec {
  return readJson(file) as BaseJsonTableSpec;
}

/**
 * Regenerate a fixture's default View from its spec using the connector's OWN pure `buildDefaultView(spec)`
 * — the MR2 `spec → view` stage, keyed by the connector slug (the part of the fixture dir name before the
 * first `-`, e.g. `airtable` in `airtable-blog-posts`). Each connector is instantiated with a throwaway
 * credential; `buildDefaultView` reads only the spec, never touches the API client, so no network call is
 * made (mirrors the existing `new WebflowConnector('test-token').buildDefaultView(spec)` pattern). This
 * exercises each connector's real dispatch (Webflow entity-type prefixes, HubSpot object config, Stripe
 * entity type, Notion standalone-pages check) with zero replicated logic to drift.
 */
const DEFAULT_VIEW_BUILDERS_BY_CONNECTOR: Record<string, (spec: BaseJsonTableSpec) => TableView | undefined> = {
  airtable: (spec) => new AirtableConnector('test-key').buildDefaultView(spec),
  framer: (spec) =>
    new FramerConnector({ projectUrl: 'https://framer.com/projects/Test--test', apiKey: 'fr_test' }).buildDefaultView(
      spec,
    ),
  webflow: (spec) => new WebflowConnector('test-token').buildDefaultView(spec),
  hubspot: (spec) => new HubspotConnector('test-token').buildDefaultView(spec),
  stripe: (spec) => new StripeConnector({ apiKey: 'test-key' }).buildDefaultView(spec),
  notion: (spec) => new NotionConnector('test-key').buildDefaultView(spec),
  pipedrive: (spec) => new PipedriveConnector('test-token').buildDefaultView(spec),
  wix: (spec) => new WixBlogConnector('test-token').buildDefaultView(spec),
};

function buildDefaultViewForFixture(fixtureName: string, spec: BaseJsonTableSpec): TableView {
  const connectorSlug = fixtureName.split('-')[0];
  const buildDefaultView = DEFAULT_VIEW_BUILDERS_BY_CONNECTOR[connectorSlug];
  if (!buildDefaultView) {
    throw new Error(
      `No default-view builder registered for connector "${connectorSlug}" (fixture "${fixtureName}"). ` +
        `Add it to DEFAULT_VIEW_BUILDERS_BY_CONNECTOR.`,
    );
  }
  const generatedView = buildDefaultView(spec);
  if (!generatedView) {
    throw new Error(`buildDefaultView returned no view for fixture "${fixtureName}"`);
  }
  return generatedView;
}

interface LoadedFixture {
  view: TableView;
  visibleCols: TableViewCol[];
  schema: BaseJsonTableSpec['schema'];
  fieldsByPath: Map<string, SchemaField>;
  records: { name: string; data: unknown }[];
  generatedDir: string;
  codecDir: string;
}

/** The synchronous setup shared by every golden for one fixture: regenerate the view + resolve its inputs
 *  and load the (input) record files. Cheap enough to run once per fixture at collection time. */
function loadFixture(fixtureName: string): LoadedFixture {
  const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
  const spec = loadSpec(path.join(fixtureDir, 'schema.json'));
  const view = buildDefaultViewForFixture(fixtureName, spec);
  const fieldsByPath = new Map(
    extractSchemaFields(spec.schema).map((field) => [field.path, field] as [string, SchemaField]),
  );
  const recordsDir = path.join(fixtureDir, 'records');
  const records = (
    fs.existsSync(recordsDir)
      ? fs
          .readdirSync(recordsDir)
          .filter((f) => f.endsWith('.json'))
          .sort()
      : []
  ).map((f) => ({ name: f.replace(/\.json$/, ''), data: readJson(path.join(recordsDir, f)) }));
  const generatedDir = path.join(fixtureDir, GENERATED_DIRNAME);
  return {
    view,
    visibleCols: visibleColumns(view),
    schema: spec.schema,
    fieldsByPath,
    records,
    generatedDir,
    codecDir: path.join(generatedDir, 'codec'),
  };
}

/** Each visible column's resolved codec — the per-connector "how each column transforms" table (the
 *  `columns.json` golden), split out from the per-record VALUES so the two drift signals land in separate
 *  files. `toCore` / `fromCore` are the transformer configs a sync would run; they're reused verbatim below
 *  to compute each record's codec output. */
function resolveFixtureColumns(loaded: LoadedFixture) {
  return loaded.visibleCols.map((col) => {
    const columnId = effectiveColumnId(col);
    const input = resolveColumnTransformInput({
      columnId,
      schema: loaded.schema,
      fieldsByPath: loaded.fieldsByPath,
      view: loaded.view,
    });
    return {
      column: col.name ?? columnId,
      columnId,
      cardinality: input.cardinality,
      logicalType: input.logicalType ?? null,
      primitiveType: input.primitiveType ?? null,
      toCore: input.toCore ?? null,
      fromCore: input.fromCore ?? null,
    };
  });
}
type ResolvedColumn = ReturnType<typeof resolveFixtureColumns>[number];

/** One record's codec output, keyed by columnId (unique, collision-free): `toCore` (extract → CORE) and,
 *  when the column declares a pack, the `fromCore` round-trip (CORE → native). This is the `codec/<record>`
 *  golden — the values only; the transformer configs live in `columns.json`. */
async function codecForRecord(
  columns: ResolvedColumn[],
  recordData: unknown,
): Promise<Record<string, { core: unknown; roundTrip?: unknown }>> {
  const output: Record<string, { core: unknown; roundTrip?: unknown }> = {};
  for (const col of columns) {
    const raw = get(recordData, col.columnId) as unknown;
    const core = await runCodec(col.toCore ?? undefined, raw);
    const entry: { core: unknown; roundTrip?: unknown } = { core: truncateForGolden(core) };
    // Only round-trip when the column declares a pack — otherwise roundTrip === core (identity).
    if (col.fromCore) entry.roundTrip = truncateForGolden(await runCodec(col.fromCore, core));
    output[col.columnId] = entry;
  }
  return output;
}

/** Jest's snapshot-update mode for this run: 'all' (`-u`), 'new' (default — write only what's missing), or
 *  'none' (CI / `--ci` — never write). Read off the same state Jest's own snapshots use so plain-JSON
 *  goldens share the exact `jest -u` ergonomics. */
function goldenUpdateMode(): 'all' | 'new' | 'none' {
  const state = expect.getState().snapshotState as unknown as { _updateSnapshot?: 'all' | 'new' | 'none' };
  return state?._updateSnapshot ?? 'new';
}

/** Compare `value` against a checked-in golden JSON file, honoring `jest -u` exactly like `toMatchSnapshot`:
 *  `-u` (re)writes it; a missing golden on a normal run is written (a "new" snapshot); otherwise assert deep
 *  equality (CI, where nothing is written, fails on a missing golden). */
function expectMatchesGolden(goldenFile: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  const mode = goldenUpdateMode();
  const exists = fs.existsSync(goldenFile);
  if (mode === 'all' || (mode === 'new' && !exists)) {
    fs.mkdirSync(path.dirname(goldenFile), { recursive: true });
    fs.writeFileSync(goldenFile, serialized);
    return;
  }
  if (!exists) {
    throw new Error(
      `Missing golden ${path.relative(FIXTURES_DIR, goldenFile)} — run ` +
        `\`jest -u src/sync/view-codec-snapshots.spec.ts\` to create it.`,
    );
  }
  // Compare through JSON on both sides so `undefined`↔absent never shows as a spurious diff.
  expect(JSON.parse(serialized)).toEqual(readJson(goldenFile));
}

/** Keep `codec/` free of goldens for records that no longer exist — the plain-JSON analogue of Jest pruning
 *  obsolete snapshots. `-u` deletes strays; a normal run fails if any are found. */
function reconcileCodecGoldens(codecDir: string, expectedRecordNames: string[]): void {
  const expected = new Set(expectedRecordNames.map((name) => `${name}.json`));
  const existing = fs.existsSync(codecDir) ? fs.readdirSync(codecDir).filter((f) => f.endsWith('.json')) : [];
  const strayGoldens = existing.filter((f) => !expected.has(f)).sort();
  if (goldenUpdateMode() === 'all') {
    for (const stray of strayGoldens) fs.unlinkSync(path.join(codecDir, stray));
    return;
  }
  expect(strayGoldens).toEqual([]);
}

const fixtures = fs.existsSync(FIXTURES_DIR)
  ? fs
      .readdirSync(FIXTURES_DIR)
      .filter((name) => fs.statSync(path.join(FIXTURES_DIR, name)).isDirectory())
      .sort()
  : [];

describe('view codec goldens (real connector data)', () => {
  it('has fixtures to exercise', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    describe(fixture, () => {
      const loaded = loadFixture(fixture);
      const columns = resolveFixtureColumns(loaded);

      it('generated default view', () => {
        expectMatchesGolden(path.join(loaded.generatedDir, 'view.json'), loaded.view);
      });

      it('resolved column codecs', () => {
        expectMatchesGolden(path.join(loaded.generatedDir, 'columns.json'), columns);
      });

      // One golden per input record, named to match it (records/<x>.json ⟶ __generated__/codec/<x>.json).
      for (const record of loaded.records) {
        it(`codec output · ${record.name}`, async () => {
          const codec = await codecForRecord(columns, record.data);
          expectMatchesGolden(path.join(loaded.codecDir, `${record.name}.json`), codec);
        });
      }

      it('has no obsolete codec goldens', () => {
        reconcileCodecGoldens(
          loaded.codecDir,
          loaded.records.map((r) => r.name),
        );
      });
    });
  }
});
