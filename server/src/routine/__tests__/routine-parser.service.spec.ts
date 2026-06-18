import { RoutineAction } from '@spinner/shared-types';
import { RoutineParserService } from '../routine-parser.service';
import { ParsedRoutine, RoutineParseResult } from '../routine.types';

function expectRoutine(result: RoutineParseResult): ParsedRoutine {
  if ('error' in result) {
    throw new Error(`expected a parsed routine but got error: ${result.error}`);
  }
  return result.routine;
}

function expectError(result: RoutineParseResult): string {
  if (!('error' in result)) {
    throw new Error('expected a parse error but parsing succeeded');
  }
  return result.error;
}

describe('RoutineParserService', () => {
  const parser = new RoutineParserService();

  it('parses a full, valid routine', () => {
    const yaml = `
name: Daily Content Sync
schedule: "0 9 * * MON-FRI"
comment: Runs every weekday morning
steps:
  - action: pull
    name: Pull posts
    folder: /blog/posts
    connection: coa_123
    comment: pull the posts
    timeout: 600
  - action: publish
    folder: dfd_abc123
`;
    const routine = expectRoutine(parser.parse(yaml));
    expect(routine.name).toBe('Daily Content Sync');
    expect(routine.schedule).toBe('0 9 * * MON-FRI');
    expect(routine.comment).toBe('Runs every weekday morning');
    expect(routine.steps).toHaveLength(2);
    expect(routine.steps[0]).toEqual({
      action: RoutineAction.PULL,
      name: 'Pull posts',
      folder: '/blog/posts',
      connection: 'coa_123',
      sync: null,
      comment: 'pull the posts',
      timeout: 600,
    });
    // Optional fields default to null, not undefined (wire fidelity).
    expect(routine.steps[1]).toEqual({
      action: RoutineAction.PUBLISH,
      name: null,
      folder: 'dfd_abc123',
      connection: null,
      sync: null,
      comment: null,
      timeout: null,
    });
  });

  it('parses a minimal routine (name + one step), nulling optional fields', () => {
    const routine = expectRoutine(parser.parse('name: Minimal\nsteps:\n  - action: pull\n'));
    expect(routine.name).toBe('Minimal');
    expect(routine.schedule).toBeNull();
    expect(routine.comment).toBeNull();
    expect(routine.steps).toEqual([
      {
        action: RoutineAction.PULL,
        name: null,
        folder: null,
        connection: null,
        sync: null,
        comment: null,
        timeout: null,
      },
    ]);
  });

  it('parses a sync step addressed by its sync_ id', () => {
    const routine = expectRoutine(parser.parse('name: Sync\nsteps:\n  - action: sync\n    sync: sync_abc123\n'));
    expect(routine.steps[0]).toEqual({
      action: RoutineAction.SYNC,
      name: null,
      folder: null,
      connection: null,
      sync: 'sync_abc123',
      comment: null,
      timeout: null,
    });
  });

  it('rejects a sync step with no sync field', () => {
    expect(expectError(parser.parse('name: Bad\nsteps:\n  - action: sync\n'))).toMatch(/sync.*require|require.*sync/i);
  });

  it('rejects a sync id that is not a sync_ id', () => {
    const error = expectError(parser.parse('name: Bad\nsteps:\n  - action: sync\n    sync: not-a-sync-id\n'));
    expect(error).toMatch(/sync/i);
  });

  it("rejects a 'sync' field on a non-sync step", () => {
    const error = expectError(parser.parse('name: Bad\nsteps:\n  - action: pull\n    sync: sync_abc123\n'));
    expect(error).toMatch(/sync.*only valid on sync/i);
  });

  it('rejects a folder on a sync step', () => {
    const yaml = 'name: Bad\nsteps:\n  - action: sync\n    sync: sync_abc123\n    folder: /blog\n';
    expect(expectError(parser.parse(yaml))).toMatch(/sync steps must not set 'folder'/i);
  });

  it('accepts the publish-plan action', () => {
    const routine = expectRoutine(parser.parse('name: Plan\nsteps:\n  - action: publish-plan\n'));
    expect(routine.steps[0].action).toBe(RoutineAction.PUBLISH_PLAN);
  });

  it('rejects a missing name', () => {
    expect(expectError(parser.parse('steps:\n  - action: pull\n'))).toMatch(/name/);
  });

  it('rejects an empty name', () => {
    expect(expectError(parser.parse('name: ""\nsteps:\n  - action: pull\n'))).toMatch(/name/);
  });

  it('rejects an empty steps list', () => {
    expect(expectError(parser.parse('name: No steps\nsteps: []\n'))).toMatch(/steps/);
  });

  it('rejects a missing steps key', () => {
    expect(expectError(parser.parse('name: No steps\n'))).toMatch(/steps/);
  });

  it('rejects an unknown action', () => {
    expect(expectError(parser.parse('name: Bad\nsteps:\n  - action: frobnicate\n'))).toMatch(/action/i);
  });

  it('rejects a folder that is neither a POSIX path nor a DataFolderId', () => {
    const error = expectError(parser.parse('name: Bad folder\nsteps:\n  - action: pull\n    folder: blog/posts\n'));
    expect(error).toMatch(/folder/);
  });

  it('rejects duplicate step names', () => {
    const yaml = `
name: Dupe
steps:
  - action: pull
    name: step
  - action: publish
    name: step
`;
    expect(expectError(parser.parse(yaml))).toMatch(/duplicate step name/i);
  });

  it('rejects a non-5-field cron schedule', () => {
    expect(expectError(parser.parse('name: Bad cron\nschedule: "* * *"\nsteps:\n  - action: pull\n'))).toMatch(
      /5-field/,
    );
  });

  it('rejects a schedule under the 5-minute minimum interval', () => {
    const error = expectError(parser.parse('name: Too frequent\nschedule: "* * * * *"\nsteps:\n  - action: pull\n'));
    expect(error).toMatch(/at least 5 minutes/);
  });

  it('accepts a valid weekday-morning schedule', () => {
    const routine = expectRoutine(parser.parse('name: OK\nschedule: "0 9 * * MON-FRI"\nsteps:\n  - action: pull\n'));
    expect(routine.schedule).toBe('0 9 * * MON-FRI');
  });

  it('rejects a per-step timeout above the action maximum', () => {
    // pull max is 3600s; 99999 exceeds it.
    const error = expectError(parser.parse('name: Slow\nsteps:\n  - action: pull\n    timeout: 99999\n'));
    expect(error).toMatch(/timeout/);
  });

  it('rejects an unknown top-level key (strict)', () => {
    expect(expectError(parser.parse('name: Strict\nbogus: nope\nsteps:\n  - action: pull\n'))).toBeTruthy();
  });

  it('returns an error (not a throw) for malformed YAML', () => {
    const result = parser.parse('name: "unterminated\nsteps: [');
    expect(expectError(result)).toMatch(/Invalid YAML/);
  });

  it('returns an error for an empty file', () => {
    expect(expectError(parser.parse(''))).toMatch(/YAML object/);
  });

  it('returns an error for a non-object top-level value', () => {
    expect(expectError(parser.parse('just a string'))).toMatch(/YAML object/);
  });
});
