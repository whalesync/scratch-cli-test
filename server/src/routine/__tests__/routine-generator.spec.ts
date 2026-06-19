import { load as loadYaml } from 'js-yaml';
import { buildSyncRoutineFile } from '../routine-generator';
import { RoutineParserService } from '../routine-parser.service';

interface ParsedRoutineYaml {
  name: string;
  steps: Array<Record<string, string>>;
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
        { action: 'pull', name: 'Pull Source', connection: 'coa_123' },
        { action: 'pull', name: 'Pull Destination', connection: 'coa_456' },
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
      expect(parseResult.routine.steps).toHaveLength(4);
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
    expect(routine.steps.map((step) => step.name)).toEqual(['Pull Destination', 'Run Sync', 'Publish to Destination']);
  });

  it('omits the destination pull and publish steps when the destination is a scratch folder', () => {
    const file = buildSyncRoutineFile({
      syncDisplayName: 'Scratch Dest',
      syncId: 'syn_scr2',
      sourceConnectorAccountIds: ['coa_src'],
      destinationConnectorAccountIds: [],
    });

    const routine = loadRoutine(file.content);
    expect(routine.steps.map((step) => step.name)).toEqual(['Pull Source', 'Run Sync']);
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
      'Pull Source',
      'Pull Destination',
      'Run Sync',
      'Publish to Destination',
    ]);
  });
});
