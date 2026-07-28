import { load as loadYaml } from 'js-yaml';
import { buildSyncRoutineFile } from '../routine-generator';
import { RoutineParserService } from '../routine-parser.service';

interface ParsedRoutineYaml {
  name: string;
  steps: Array<Record<string, unknown>>;
}

const parser = new RoutineParserService();

/** Parses the generated YAML back into a plain object for structural assertions. */
function loadRoutine(content: string): ParsedRoutineYaml {
  return loadYaml(content) as ParsedRoutineYaml;
}

describe('buildSyncRoutineFile', () => {
  it('builds the canonical pull→pull→sync→publish routine for a single source + destination', () => {
    const file = buildSyncRoutineFile({
      syncDisplayName: 'Contacts Sync',
      syncId: 'syn_111111',
      sourceConnectorAccountIds: ['coa_123'],
      destinationConnectorAccountIds: ['coa_456'],
    });

    expect(file.path).toBe('routines/run-syn_111111.yaml');
    expect(loadRoutine(file.content)).toEqual({
      name: 'Run Sync Contacts Sync',
      steps: [
        {
          action: 'discard-pending-changes',
          name: 'Prepare workspace for sync',
          comment: 'Pre-flight: clear any leftover unpublished edits so the sync starts from a clean slate.',
        },
        { action: 'pull', name: 'Pull Source', connection: 'coa_123', options: { fullPull: true } },
        { action: 'pull', name: 'Pull Destination', connection: 'coa_456', options: { fullPull: true } },
        { action: 'sync', name: 'Run Sync', sync: 'syn_111111' },
        { action: 'publish', name: 'Publish to Destination', connection: 'coa_456' },
      ],
    });
  });

  it('generates YAML that parses cleanly through the routine parser', () => {
    // A realistic 14-char SyncId (syn_ + 10): the parser refines the step's `sync` via isSyncId.
    const file = buildSyncRoutineFile({
      syncDisplayName: 'Contacts Sync',
      syncId: 'syn_abcde12345',
      sourceConnectorAccountIds: ['coa_123'],
      destinationConnectorAccountIds: ['coa_456'],
    });

    const parseResult = parser.parse(file.content);
    expect('routine' in parseResult).toBe(true);
    if ('routine' in parseResult) {
      expect(parseResult.routine.name).toBe('Run Sync Contacts Sync');
      expect(parseResult.routine.steps).toHaveLength(5);
    }
  });

  it('suffixes step names so multiple source connections stay unique', () => {
    const file = buildSyncRoutineFile({
      syncDisplayName: 'Multi Source',
      syncId: 'syn_multisrc01',
      sourceConnectorAccountIds: ['coa_a', 'coa_b'],
      destinationConnectorAccountIds: ['coa_dest'],
    });

    const routine = loadRoutine(file.content);
    expect(routine.steps.map((step) => step.name)).toEqual([
      'Prepare workspace for sync',
      'Pull Source (coa_a)',
      'Pull Source (coa_b)',
      'Pull Destination',
      'Run Sync',
      'Publish to Destination',
    ]);
    // Unique names are a hard requirement of the parser — the generated routine must satisfy it.
    expect('routine' in parser.parse(file.content)).toBe(true);
  });

  it('emits a unique-named pull + publish step per destination connection', () => {
    const file = buildSyncRoutineFile({
      syncDisplayName: 'Multi Dest',
      syncId: 'syn_multidst02',
      sourceConnectorAccountIds: ['coa_src'],
      destinationConnectorAccountIds: ['coa_x', 'coa_y'],
    });

    const routine = loadRoutine(file.content);
    expect(routine.steps.map((step) => step.name)).toEqual([
      'Prepare workspace for sync',
      'Pull Source',
      'Pull Destination (coa_x)',
      'Pull Destination (coa_y)',
      'Run Sync',
      'Publish to Destination (coa_x)',
      'Publish to Destination (coa_y)',
    ]);
    expect('routine' in parser.parse(file.content)).toBe(true);
  });

  it('omits the source pull step when the source has no connector account (scratch folder)', () => {
    const file = buildSyncRoutineFile({
      syncDisplayName: 'Scratch Source',
      syncId: 'syn_scr1',
      sourceConnectorAccountIds: [],
      destinationConnectorAccountIds: ['coa_dest'],
    });

    const routine = loadRoutine(file.content);
    expect(routine.steps.map((step) => step.name)).toEqual([
      'Prepare workspace for sync',
      'Pull Destination',
      'Run Sync',
      'Publish to Destination',
    ]);
  });

  it('omits the destination pull and publish steps when the destination is a scratch folder', () => {
    const file = buildSyncRoutineFile({
      syncDisplayName: 'Scratch Dest',
      syncId: 'syn_scr2',
      sourceConnectorAccountIds: ['coa_src'],
      destinationConnectorAccountIds: [],
    });

    const routine = loadRoutine(file.content);
    expect(routine.steps.map((step) => step.name)).toEqual(['Prepare workspace for sync', 'Pull Source', 'Run Sync']);
  });

  it('deduplicates repeated connector account ids into a single step per side', () => {
    const file = buildSyncRoutineFile({
      syncDisplayName: 'Dupes',
      syncId: 'syn_dupe1',
      sourceConnectorAccountIds: ['coa_src', 'coa_src'],
      destinationConnectorAccountIds: ['coa_dest', 'coa_dest'],
    });

    const routine = loadRoutine(file.content);
    expect(routine.steps.map((step) => step.name)).toEqual([
      'Prepare workspace for sync',
      'Pull Source',
      'Pull Destination',
      'Run Sync',
      'Publish to Destination',
    ]);
  });

  it('marks every pull step — source and destination — as a full pull', () => {
    // Incremental pulls skip stale-file reconciliation, so an upstream delete (or a destination page
    // archived out of its list endpoint) would never reach the sync. Every generated pull says full.
    const file = buildSyncRoutineFile({
      syncDisplayName: 'Full Pulls',
      syncId: 'syn_fulla12345',
      sourceConnectorAccountIds: ['coa_src_a', 'coa_src_b'],
      destinationConnectorAccountIds: ['coa_dest_a', 'coa_dest_b'],
    });

    const pullSteps = loadRoutine(file.content).steps.filter((step) => step.action === 'pull');
    expect(pullSteps).toHaveLength(4);
    for (const pullStep of pullSteps) {
      expect(pullStep.options).toEqual({ fullPull: true });
    }
    // The shared options object must be emitted inline on every step, never as a YAML anchor/alias
    // (`&ref_0` / `*ref_0`) — the parser's strict step schema would reject an alias-shaped value.
    expect(file.content).not.toContain('*ref_');

    // And the result still round-trips through the real parser, which rejects unknown option keys.
    const parseResult = parser.parse(file.content);
    expect('routine' in parseResult).toBe(true);
  });
});
