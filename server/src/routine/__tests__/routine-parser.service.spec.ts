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
    folder: dfd_0123456789
`;
    const routine = expectRoutine(parser.parse(yaml));
    expect(routine.name).toBe('Daily Content Sync');
    // The `schedule:` key in the YAML is tolerated but ignored (schedules live in the DB); its
    // presence is flagged so it can surface as a deprecation warning.
    expect(routine.deprecatedScheduleFieldPresent).toBe(true);
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
      options: null,
    });
    // Optional fields default to null, not undefined (wire fidelity).
    expect(routine.steps[1]).toEqual({
      action: RoutineAction.PUBLISH,
      name: null,
      folder: 'dfd_0123456789',
      connection: null,
      sync: null,
      comment: null,
      timeout: null,
      options: null,
    });
  });

  it('parses a minimal routine (name + one step), nulling optional fields', () => {
    const routine = expectRoutine(parser.parse('name: Minimal\nsteps:\n  - action: pull\n'));
    expect(routine.name).toBe('Minimal');
    expect(routine.deprecatedScheduleFieldPresent).toBe(false);
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
        options: null,
      },
    ]);
  });

  it('parses a sync step addressed by its syn_ id', () => {
    const routine = expectRoutine(parser.parse('name: Sync\nsteps:\n  - action: sync\n    sync: syn_0123456789\n'));
    expect(routine.steps[0]).toEqual({
      action: RoutineAction.SYNC,
      name: null,
      folder: null,
      connection: null,
      sync: 'syn_0123456789',
      comment: null,
      timeout: null,
      options: null,
    });
  });

  it('parses a pull step with options.fullPull', () => {
    const routine = expectRoutine(
      parser.parse('name: Full\nsteps:\n  - action: pull\n    options:\n      fullPull: true\n'),
    );
    expect(routine.steps[0].options).toEqual({ fullPull: true });
  });

  it("rejects the 'fullPull' option on a non-pull step", () => {
    const error = expectError(
      parser.parse('name: Bad\nsteps:\n  - action: publish\n    options:\n      fullPull: true\n'),
    );
    expect(error).toMatch(/fullPull.*only valid on pull/i);
  });

  it('rejects an unknown option key (strict)', () => {
    const error = expectError(parser.parse('name: Bad\nsteps:\n  - action: pull\n    options:\n      bogus: true\n'));
    expect(error).toBeTruthy();
  });

  it('rejects a sync step with no sync field', () => {
    expect(expectError(parser.parse('name: Bad\nsteps:\n  - action: sync\n'))).toMatch(/sync.*require|require.*sync/i);
  });

  it('rejects a sync id that is not a syn_ id', () => {
    const error = expectError(parser.parse('name: Bad\nsteps:\n  - action: sync\n    sync: not-a-sync-id\n'));
    expect(error).toMatch(/sync/i);
  });

  it("rejects a 'sync' field on a non-sync step", () => {
    const error = expectError(parser.parse('name: Bad\nsteps:\n  - action: pull\n    sync: syn_0123456789\n'));
    expect(error).toMatch(/sync.*only valid on sync/i);
  });

  it('rejects a folder on a sync step', () => {
    const yaml = 'name: Bad\nsteps:\n  - action: sync\n    sync: syn_0123456789\n    folder: /blog\n';
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

  it('tolerates and ignores a deprecated `schedule:` key, flagging it for a deprecation warning', () => {
    const routine = expectRoutine(parser.parse('name: Sched\nschedule: "0 9 * * MON-FRI"\nsteps:\n  - action: pull\n'));
    expect(routine.deprecatedScheduleFieldPresent).toBe(true);
    // The cron is no longer extracted into the parsed routine — schedules live in the Schedule DB table.
    expect('schedule' in routine).toBe(false);
  });

  it('tolerates a `schedule:` value that used to be rejected (the key is ignored, not validated)', () => {
    // "* * *" (non-5-field) and "* * * * *" (sub-5-min) once failed parsing; now the key is ignored.
    expect(
      expectRoutine(parser.parse('name: A\nschedule: "* * *"\nsteps:\n  - action: pull\n'))
        .deprecatedScheduleFieldPresent,
    ).toBe(true);
    expect(
      expectRoutine(parser.parse('name: B\nschedule: "* * * * *"\nsteps:\n  - action: pull\n'))
        .deprecatedScheduleFieldPresent,
    ).toBe(true);
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
