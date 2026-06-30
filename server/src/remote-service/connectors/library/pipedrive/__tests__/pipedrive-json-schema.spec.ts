/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import { FormatRegistry } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  X_SCRATCH_CONNECTOR_DATA_TYPE,
  X_SCRATCH_FOREIGN_KEY_OPTIONS,
  X_SCRATCH_READONLY,
} from '@spinner/shared-types';
import { PipedriveApiClient } from '../pipedrive-api-client';
import { buildPipedriveJsonTableSpec, pipedriveFieldToJsonSchema } from '../pipedrive-json-schema';
import { PipedriveField } from '../pipedrive-types';

// Mock display-names to break circular import chain
jest.mock('../../../display-names', () => ({
  getServiceDisplayName: jest.fn(() => 'Pipedrive'),
}));

// The generated schema annotates strings with `format: 'date' | 'date-time'`. Nothing runs
// Value.Check against these schemas at runtime (they are serialized and stored), so the codebase
// registers no format validators. The regression lock below is a *structural* check, so register
// permissive validators (any string) — otherwise TypeBox treats the unknown formats as failures.
for (const format of ['date', 'date-time']) {
  if (!FormatRegistry.Has(format)) {
    FormatRegistry.Set(format, (value) => typeof value === 'string');
  }
}

function makeField(overrides: Partial<PipedriveField> & { field_type: string }): PipedriveField {
  return {
    field_name: overrides.field_name ?? 'Test Field',
    field_code: overrides.field_code ?? 'test_field',
    field_type: overrides.field_type,
    is_custom_field: overrides.is_custom_field ?? false,
    options: overrides.options ?? null,
    subfields: overrides.subfields ?? null,
  };
}

describe('pipedriveFieldToJsonSchema', () => {
  it('maps varchar to String | Null', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'varchar' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf).toHaveLength(2);
  });

  it('maps text to String | Null', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'text' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf).toHaveLength(2);
  });

  it('maps double to Number | Null', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'double' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf).toHaveLength(2);
  });

  it('maps a date-only field to String(format: date) | Null', () => {
    // `field_code: 'test_field'` is not a `_time` timestamp field, so it stays date-only.
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'date', field_code: 'due_date' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const stringType = schema!.anyOf?.find((s: { type?: string }) => s.type === 'string');
    expect(stringType?.format).toBe('date');
  });

  // Pipedrive zero-date birthdays: an unset date-only field can come back as the empty-date
  // sentinel `"0000-00-00"` (or its proleptic-Gregorian normalization `"-0001-11-30"`) instead
  // of `null`. Both are legitimate verbatim API output but neither satisfies `format: 'date'`,
  // so the date-only union must admit them as `const` members or verbatim records false-fail.
  it.each(['0000-00-00', '-0001-11-30'])('admits the empty-date sentinel %s on a date-only field', (sentinel) => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'date', field_code: 'birthday' }));
    expect(schema).toBeDefined();
    // Structural: a `const`-valued member for the sentinel sits alongside the format:'date' member.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const sentinelMember = schema!.anyOf?.find((s: { const?: string }) => s.const === sentinel);
    expect(sentinelMember).toBeDefined();
    // Behavior: under a STRICT date-format validator the sentinel still validates — proving the
    // sentinel member (not the permissive format) is what carries it. The strict validator parses
    // the value as a real calendar date (rejecting both `0000-00-00`'s out-of-range month/day and
    // `-0001-11-30`'s negative year), mirroring the CLI validator's `format: 'date'` semantics.
    // Save/restore the registry so the permissive validator the rest of this file relies on is kept.
    const isStrictIsoDate = (value: unknown): boolean => {
      if (typeof value !== 'string') return false;
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      if (!match) return false;
      const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
      const parsed = new Date(Date.UTC(year, month - 1, day));
      return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
    };
    const previousDateValidator = FormatRegistry.Get('date');
    try {
      FormatRegistry.Set('date', isStrictIsoDate);
      expect(isStrictIsoDate(sentinel)).toBe(false); // sentinel is NOT a strict ISO calendar date
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(Value.Check(schema!, sentinel)).toBe(true); // …yet the verbatim record validates
      // A real date and null still validate; a genuinely malformed string still fails — we only
      // widened the union by the two known sentinels.
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(Value.Check(schema!, '1990-05-14')).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(Value.Check(schema!, null)).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(Value.Check(schema!, 'not-a-date')).toBe(false);
    } finally {
      if (previousDateValidator) {
        FormatRegistry.Set('date', previousDateValidator);
      }
    }
  });

  // DEV-10453 finding 3: Pipedrive types its timestamp system fields as `field_type: 'date'`
  // but returns full RFC 3339 date-times; mapping them to `format: 'date'` floods verbatim
  // records with false-positive format errors. `_time`-suffixed date fields get `date-time`.
  it.each(['add_time', 'update_time', 'marked_as_done_time'])(
    'maps the timestamp field %s to String(format: date-time) | Null',
    (field_code) => {
      const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'date', field_code }));
      expect(schema).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const stringType = schema!.anyOf?.find((s: { type?: string }) => s.type === 'string');
      expect(stringType?.format).toBe('date-time');
    },
  );

  it('maps phone to array with CONNECTOR_DATA_TYPE annotation', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'phone' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.type).toBe('array');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('phone');
  });

  // DEV-10453 finding 3: in v2 only CUSTOM monetary fields are `{value, currency}` objects; the
  // SYSTEM monetary fields (value/acv/arr/mrr) are flat decimal numbers, so an object schema fails
  // verbatim records like `value: 15000`.
  it('maps a CUSTOM monetary field to a nullable {value, currency} object with the monetary annotation', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'monetary', is_custom_field: true }));
    expect(schema).toBeDefined();
    // The annotation sits on the OUTER nullable union (sibling of anyOf), matching `picture`.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('monetary');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const objectBranch = schema!.anyOf.find((s: { type?: string }) => s.type === 'object');
    expect(objectBranch?.properties).toHaveProperty('value');
    expect(objectBranch?.properties).toHaveProperty('currency');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf.some((s: { type?: string }) => s.type === 'null')).toBe(true);
  });

  it('maps a SYSTEM monetary field (value/mrr/arr/acv) to Number | Null (v2 flat money)', () => {
    const schema = pipedriveFieldToJsonSchema(
      makeField({ field_type: 'monetary', field_code: 'value', is_custom_field: false }),
    );
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_CONNECTOR_DATA_TYPE]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf.map((s: { type?: string }) => s.type).sort()).toEqual(['null', 'number']);
  });

  it('maps address to a nullable object with CONNECTOR_DATA_TYPE annotation', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'address' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('address');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf.some((s: { type?: string }) => s.type === 'object')).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf.some((s: { type?: string }) => s.type === 'null')).toBe(true);
  });

  // DEV-10453 finding 3: composite object field types must admit `null` (Pipedrive returns null
  // for an empty address/monetary/daterange/timerange) or verbatim records fail validation.
  it.each(['daterange', 'timerange', 'address'])(
    'maps composite field type %s to a nullable union so empty (null) records validate',
    (field_type) => {
      const schema = pipedriveFieldToJsonSchema(makeField({ field_type }));
      expect(schema).toBeDefined();
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(schema!.anyOf).toHaveLength(2);
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      expect(schema!.anyOf.some((s: { type?: string }) => s.type === 'null')).toBe(true);
    },
  );

  // DEV-10453 finding 3: emails/participants are arrays of objects (not strings) and project_id is
  // a number (not a string). They're keyed on field_code because Pipedrive's metadata field_type
  // misdescribes them — there is no dedicated `email`/`participants` field type.
  it.each(['email', 'emails'])('maps the %s field_code to a contact array mirroring phone', (field_code) => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_code, field_type: 'varchar' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.type).toBe('array');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('email');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.items.properties).toHaveProperty('value');
  });

  it('maps the participants field_code to a [{person_id, primary?}] array', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_code: 'participants', field_type: 'varchar' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.type).toBe('array');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.items.properties).toHaveProperty('person_id');
  });

  it('maps the project_id field_code to Number | Null (stored numerically, not a string)', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_code: 'project_id', field_type: 'varchar' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf.map((s: { type?: string }) => s.type).sort()).toEqual(['null', 'number']);
  });

  it('maps a numeric enum to an OPEN union (literals + number + null) so out-of-set values validate', () => {
    const schema = pipedriveFieldToJsonSchema(
      makeField({
        field_type: 'enum',
        options: [
          { id: 1, label: 'Option A' },
          { id: 2, label: 'Option B' },
        ],
      }),
    );
    expect(schema).toBeDefined();
    // Open enum: [Literal(1), Literal(2), Number, Null]. The base scalar admits verbatim values
    // outside the current option set (deleted/disabled/new options) per external data fidelity.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf).toHaveLength(4);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf.some((s: { type?: string }) => s.type === 'number')).toBe(true);
    // A value outside the option set still validates.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(Value.Check(schema!, 999)).toBe(true);
  });

  it('maps a key_string enum (activity `type`) to an OPEN string union so default/deleted types validate', () => {
    const schema = pipedriveFieldToJsonSchema(
      makeField({
        field_code: 'type',
        field_type: 'enum',
        options: [
          { id: 'call', label: 'Call' },
          { id: 'meeting', label: 'Meeting' },
        ],
      }),
    );
    expect(schema).toBeDefined();
    // The base scalar matches the option-id type: string key_strings for the activity `type` field.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf.some((s: { type?: string }) => s.type === 'string')).toBe(true);
    // A verbatim type outside the discovered options (e.g. a Pipedrive default or deleted type).
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(Value.Check(schema!, 'email')).toBe(true);
  });

  it('maps set to an array whose items are an OPEN union (literals + number) so out-of-set ids validate', () => {
    const schema = pipedriveFieldToJsonSchema(
      makeField({
        field_type: 'set',
        options: [
          { id: 10, label: 'Tag A' },
          { id: 20, label: 'Tag B' },
        ],
      }),
    );
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.type).toBe('array');
    // An array containing an id outside the option set still validates (deleted/added option).
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(Value.Check(schema!, [10, 999])).toBe(true);
  });

  it('maps a CUSTOM time field to a nullable {value, timezone_id, timezone_name} object with the time annotation', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'time', is_custom_field: true }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_CONNECTOR_DATA_TYPE]).toBe('time');
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf).toHaveLength(2);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const objectBranch = schema!.anyOf.find((s: { type?: string }) => s.type === 'object');
    expect(objectBranch?.properties).toHaveProperty('value');
    expect(objectBranch?.properties).toHaveProperty('timezone_id');
    expect(objectBranch?.properties).toHaveProperty('timezone_name');
    // The verbatim Pipedrive object shape validates.
    expect(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      Value.Check(schema!, {
        value: '12:00:00',
        timezone_id: 272,
        timezone_name: 'Asia/Singapore',
      }),
    ).toBe(true);
  });

  it('maps a SYSTEM time field (due_time) to String | Null (plain clock string, not an object)', () => {
    const schema = pipedriveFieldToJsonSchema(
      makeField({ field_type: 'time', field_code: 'due_time', is_custom_field: false }),
    );
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_CONNECTOR_DATA_TYPE]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf.map((s: { type?: string }) => s.type).sort()).toEqual(['null', 'string']);
  });

  it('maps picture to a Number | {url} | Null readonly union (v2 returns a bare numeric id)', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'picture' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_READONLY]).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf.some((s: { type?: string }) => s.type === 'number')).toBe(true);
    // A bare numeric picture_id (the v2 verbatim shape) validates.
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(Value.Check(schema!, 183)).toBe(true);
  });

  it('maps a v1 leads CUSTOM monetary field to Number | Null (v1 returns a bare number, not an object)', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'monetary', is_custom_field: true }), {
      apiVersion: 'v1',
    });
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_CONNECTOR_DATA_TYPE]).toBeUndefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf.map((s: { type?: string }) => s.type).sort()).toEqual(['null', 'number']);
  });

  it('maps a v1 leads CUSTOM set field to String | Null (v1 returns a comma-joined id string)', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'set', is_custom_field: true }), {
      apiVersion: 'v1',
    });
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema!.anyOf.map((s: { type?: string }) => s.type).sort()).toEqual(['null', 'string']);
  });

  it('maps org to Number | Null with FOREIGN_KEY_OPTIONS', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'org' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'organizations' });
  });

  it('maps people to Number | Null with FOREIGN_KEY_OPTIONS', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'people' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'persons' });
  });

  it('maps deal to Number | Null with FOREIGN_KEY_OPTIONS', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'deal' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'deals' });
  });

  it('maps stage to Number | Null with FOREIGN_KEY_OPTIONS to stages', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'stage' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'stages' });
  });

  it('maps user to Number | Null with READONLY_FLAG', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'user' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_READONLY]).toBe(true);
  });

  it('maps varchar_auto to String | Null with READONLY_FLAG', () => {
    const schema = pipedriveFieldToJsonSchema(makeField({ field_type: 'varchar_auto' }));
    expect(schema).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(schema![X_SCRATCH_READONLY]).toBe(true);
  });
});

describe('buildPipedriveJsonTableSpec', () => {
  const mockClient = {
    getFields: jest.fn(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('builds spec with system and custom fields', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'id', field_name: 'ID', field_type: 'int', is_custom_field: false }),
      makeField({ field_code: 'title', field_name: 'Title', field_type: 'varchar', is_custom_field: false }),
      makeField({ field_code: 'add_time', field_name: 'Created', field_type: 'date', is_custom_field: false }),
      makeField({
        field_code: 'abc123hash',
        field_name: 'My Custom',
        field_type: 'varchar',
        is_custom_field: true,
      }),
    ]);

    const entityId = { wsId: 'deals', remoteId: ['deals'] };
    const spec = await buildPipedriveJsonTableSpec(entityId, 'deals', mockClient as unknown as PipedriveApiClient);

    expect(spec.name).toBe('Deals');
    expect(spec.idPath).toBe('id');
    expect(spec.titlePath).toEqual('title');
    expect(spec.schema.properties).toHaveProperty('id');
    expect(spec.schema.properties).toHaveProperty('title');
    expect(spec.schema.properties).toHaveProperty('custom_fields');
    expect(spec.schema.properties.custom_fields.properties).toHaveProperty('abc123hash');
  });

  it('marks id, add_time, update_time as read-only', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'id', field_name: 'ID', field_type: 'int', is_custom_field: false }),
      makeField({ field_code: 'add_time', field_name: 'Created', field_type: 'date', is_custom_field: false }),
      makeField({ field_code: 'update_time', field_name: 'Updated', field_type: 'date', is_custom_field: false }),
    ]);

    const entityId = { wsId: 'persons', remoteId: ['persons'] };
    const spec = await buildPipedriveJsonTableSpec(entityId, 'persons', mockClient as unknown as PipedriveApiClient);

    expect(spec.schema.properties.id[X_SCRATCH_READONLY]).toBe(true);
    expect(spec.schema.properties.add_time[X_SCRATCH_READONLY]).toBe(true);
    expect(spec.schema.properties.update_time[X_SCRATCH_READONLY]).toBe(true);
  });

  it('marks activity person_id/org_id read-only (v2 read-only relations set via participants) — DEV-10453', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'subject', field_name: 'Subject', field_type: 'varchar', is_custom_field: false }),
      makeField({ field_code: 'person_id', field_name: 'Person', field_type: 'people', is_custom_field: false }),
      makeField({ field_code: 'org_id', field_name: 'Organization', field_type: 'org', is_custom_field: false }),
    ]);

    const spec = await buildPipedriveJsonTableSpec(
      { wsId: 'activities', remoteId: ['activities'] },
      'activities',
      mockClient as unknown as PipedriveApiClient,
    );

    expect(spec.schema.properties.person_id[X_SCRATCH_READONLY]).toBe(true);
    expect(spec.schema.properties.org_id[X_SCRATCH_READONLY]).toBe(true);
    // A writable system field stays writable.
    expect(spec.schema.properties.subject[X_SCRATCH_READONLY]).toBeUndefined();
  });

  it('omits custom_fields property when there are no custom fields', async () => {
    mockClient.getFields.mockResolvedValue([
      makeField({ field_code: 'id', field_name: 'ID', field_type: 'int', is_custom_field: false }),
      makeField({ field_code: 'name', field_name: 'Name', field_type: 'varchar', is_custom_field: false }),
    ]);

    const entityId = { wsId: 'organizations', remoteId: ['organizations'] };
    const spec = await buildPipedriveJsonTableSpec(
      entityId,
      'organizations',
      mockClient as unknown as PipedriveApiClient,
    );

    expect(spec.schema.properties).not.toHaveProperty('custom_fields');
  });

  describe('leads (v1: static system fields + flat custom fields)', () => {
    it('uses the static lead system schema and places custom fields flat (top-level, not nested)', async () => {
      // Leads share deals' custom fields; the Fields endpoint returns both deal
      // system fields (ignored for leads) and custom fields (kept, placed flat).
      mockClient.getFields.mockResolvedValue([
        makeField({ field_code: 'stage_id', field_name: 'Stage', field_type: 'stage', is_custom_field: false }),
        makeField({
          field_code: 'deadbeefhash',
          field_name: 'My Custom',
          field_type: 'varchar',
          is_custom_field: true,
        }),
      ]);

      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'leads', remoteId: ['leads'] },
        'leads',
        mockClient as unknown as PipedriveApiClient,
      );

      expect(spec.name).toBe('Leads');
      expect(spec.titlePath).toEqual('title');
      // Static lead system fields are present...
      expect(spec.schema.properties).toHaveProperty('title');
      expect(spec.schema.properties).toHaveProperty('value');
      expect(spec.schema.properties).toHaveProperty('person_id');
      // ...the deal-only dynamic system field is NOT pulled in...
      expect(spec.schema.properties).not.toHaveProperty('stage_id');
      // ...the custom field is flat at the top level (no custom_fields wrapper)...
      expect(spec.schema.properties).not.toHaveProperty('custom_fields');
      expect(spec.schema.properties).toHaveProperty('deadbeefhash');
    });

    it('marks the lead id and update_time read-only and annotates update_time as last-modified', async () => {
      mockClient.getFields.mockResolvedValue([]);
      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'leads', remoteId: ['leads'] },
        'leads',
        mockClient as unknown as PipedriveApiClient,
      );
      expect(spec.schema.properties.id[X_SCRATCH_READONLY]).toBe(true);
      expect(spec.schema.properties.update_time[X_SCRATCH_READONLY]).toBe(true);
      expect(spec.schema.properties.update_time['x-scratch-last-modified-field']).toBe(true);
    });
  });

  describe('notes (v1: fully static, no Fields endpoint, no title)', () => {
    it('builds the static note schema without calling getFields and without a title column', async () => {
      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'notes', remoteId: ['notes'] },
        'notes',
        mockClient as unknown as PipedriveApiClient,
      );

      expect(mockClient.getFields).not.toHaveBeenCalled();
      expect(spec.name).toBe('Notes');
      expect(spec.titlePath).toBeUndefined();
      expect(spec.schema.properties).toHaveProperty('content');
      expect(spec.schema.properties).toHaveProperty('deal_id');
      expect(spec.schema.properties).not.toHaveProperty('custom_fields');
      // All six parent-attachment targets are modelled — Pipedrive requires one of
      // them on create, but that "one of" constraint can't live in a flat required
      // array, so each is an optional property (DEV-10453).
      expect(spec.schema.properties).toHaveProperty('lead_id');
      expect(spec.schema.properties).toHaveProperty('project_id');
      expect(spec.schema.properties).toHaveProperty('task_id');
      // The server-hydrated stub objects are read-only.
      expect(spec.schema.properties.person[X_SCRATCH_READONLY]).toBe(true);
    });
  });

  describe('deals foreign keys to pipeline config', () => {
    it('wires deals.pipeline_id (a plain double) and stage_id as foreign keys', async () => {
      mockClient.getFields.mockResolvedValue([
        makeField({ field_code: 'id', field_name: 'ID', field_type: 'int' }),
        makeField({ field_code: 'pipeline_id', field_name: 'Pipeline', field_type: 'double' }),
        makeField({ field_code: 'stage_id', field_name: 'Stage', field_type: 'stage' }),
      ]);

      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'deals', remoteId: ['deals'] },
        'deals',
        mockClient as unknown as PipedriveApiClient,
      );

      expect(spec.schema.properties.pipeline_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'pipelines' });
      expect(spec.schema.properties.stage_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'stages' });
    });
  });

  describe('pipelines / stages (v2 config: static, no custom fields, not incremental)', () => {
    it('builds a static pipelines schema (no getFields, name title, no last-modified annotation)', async () => {
      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'pipelines', remoteId: ['pipelines'] },
        'pipelines',
        mockClient as unknown as PipedriveApiClient,
      );

      expect(mockClient.getFields).not.toHaveBeenCalled();
      expect(spec.name).toBe('Pipelines');
      expect(spec.titlePath).toEqual('name');
      expect(spec.schema.properties).toHaveProperty('name');
      expect(spec.schema.properties).not.toHaveProperty('custom_fields');
      expect(spec.schema.properties.update_time[X_SCRATCH_READONLY]).toBe(true);
      // update_time is intentionally NOT a last-modified field — the pipelines
      // endpoint rejects updated_since, so incremental pulls are unsupported.
      expect(spec.schema.properties.update_time['x-scratch-last-modified-field']).toBeUndefined();
    });

    it('builds a static stages schema with pipeline_id as a foreign key to pipelines', async () => {
      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'stages', remoteId: ['stages'] },
        'stages',
        mockClient as unknown as PipedriveApiClient,
      );

      expect(spec.name).toBe('Stages');
      expect(spec.schema.properties.pipeline_id[X_SCRATCH_FOREIGN_KEY_OPTIONS]).toEqual({ linkedTableId: 'pipelines' });
      expect(spec.schema.properties.update_time['x-scratch-last-modified-field']).toBeUndefined();
    });
  });

  // The schema's `required` array must list ONLY genuinely create-required writable
  // fields — never a read-only field, and not "every field" (TypeBox's default).
  describe('required array (optional-by-default; read-only ⇒ not-required) — DEV-10453', () => {
    it('requires only the create-mandatory writable field and never read-only fields (deals)', async () => {
      mockClient.getFields.mockResolvedValue([
        makeField({ field_code: 'id', field_name: 'ID', field_type: 'int' }),
        makeField({ field_code: 'title', field_name: 'Title', field_type: 'varchar' }),
        makeField({ field_code: 'value', field_name: 'Value', field_type: 'monetary' }),
        makeField({ field_code: 'add_time', field_name: 'Created', field_type: 'date' }),
        makeField({ field_code: 'update_time', field_name: 'Updated', field_type: 'date' }),
        makeField({ field_code: 'owner_id', field_name: 'Owner', field_type: 'user' }),
        makeField({ field_code: 'abc123hash', field_name: 'My Custom', field_type: 'varchar', is_custom_field: true }),
      ]);

      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'deals', remoteId: ['deals'] },
        'deals',
        mockClient as unknown as PipedriveApiClient,
      );

      // Title is the only required field.
      expect(spec.schema.required).toEqual(['title']);
      // Read-only system fields are NOT required (the core DEV-10453 invariant).
      expect(spec.schema.required).not.toContain('id');
      expect(spec.schema.required).not.toContain('add_time');
      expect(spec.schema.required).not.toContain('update_time');
      // A read-only-by-type field (user) is not required either.
      expect(spec.schema.required).not.toContain('owner_id');
      // A writable but non-mandatory field is optional.
      expect(spec.schema.required).not.toContain('value');
      // The custom_fields wrapper is optional...
      expect(spec.schema.required).not.toContain('custom_fields');
      // ...and individual custom fields are optional (no nested required array).
      expect(spec.schema.properties.custom_fields.required).toBeUndefined();
    });

    it('marks no field required when the entity has no create-mandatory field (activities)', async () => {
      mockClient.getFields.mockResolvedValue([
        makeField({ field_code: 'id', field_name: 'ID', field_type: 'int' }),
        makeField({ field_code: 'subject', field_name: 'Subject', field_type: 'varchar' }),
        makeField({ field_code: 'person_id', field_name: 'Person', field_type: 'people' }),
        makeField({ field_code: 'org_id', field_name: 'Organization', field_type: 'org' }),
      ]);

      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'activities', remoteId: ['activities'] },
        'activities',
        mockClient as unknown as PipedriveApiClient,
      );

      // subject is optional on create in v2, so nothing is required at all.
      expect(spec.schema.required).toBeUndefined();
    });

    it('requires create-mandatory writable fields for a static entity and excludes read-only ones (stages)', async () => {
      const spec = await buildPipedriveJsonTableSpec(
        { wsId: 'stages', remoteId: ['stages'] },
        'stages',
        mockClient as unknown as PipedriveApiClient,
      );

      expect(spec.schema.required).toEqual(expect.arrayContaining(['name', 'pipeline_id']));
      expect(spec.schema.required).toHaveLength(2);
      expect(spec.schema.required).not.toContain('id');
      expect(spec.schema.required).not.toContain('add_time');
      expect(spec.schema.required).not.toContain('update_time');
    });

    it('requires only content for notes and title for leads, never their read-only fields', async () => {
      const notes = await buildPipedriveJsonTableSpec(
        { wsId: 'notes', remoteId: ['notes'] },
        'notes',
        mockClient as unknown as PipedriveApiClient,
      );
      expect(notes.schema.required).toEqual(['content']);
      expect(notes.schema.required).not.toContain('id');

      mockClient.getFields.mockResolvedValue([]);
      const leads = await buildPipedriveJsonTableSpec(
        { wsId: 'leads', remoteId: ['leads'] },
        'leads',
        mockClient as unknown as PipedriveApiClient,
      );
      expect(leads.schema.required).toEqual(['title']);
      expect(leads.schema.required).not.toContain('id');
      expect(leads.schema.required).not.toContain('creator_id');
    });
  });
});

/**
 * REGRESSION LOCK (DEV-10453, finding 3): validate verbatim Pipedrive v2 records against the schema
 * the connector actually generates. This is the test that would have caught the structural
 * type-mismatches that flooded `enforce_schema`: non-nullable composite objects that are `null` in
 * the data, system monetary fields typed as objects when v2 returns flat numbers, and
 * emails/participants typed as strings when they are arrays of objects. (Extra top-level keys like
 * deals' root `currency` pass via the default `additionalProperties: true`.)
 */
describe('schema regression lock — verbatim v2 records validate against the generated schema', () => {
  const mockClient = { getFields: jest.fn() };
  beforeEach(() => jest.clearAllMocks());

  /** Assert Value.Check passes, dumping the first few validation errors otherwise. */
  function expectValid(schema: unknown, record: unknown): void {
    const schemaT = schema as Parameters<typeof Value.Check>[0];
    if (!Value.Check(schemaT, record)) {
      const errors = [...Value.Errors(schemaT, record)].slice(0, 10).map((e) => `${e.path}: ${e.message}`);
      throw new Error(`record did not validate against generated schema:\n${errors.join('\n')}`);
    }
    expect(Value.Check(schemaT, record)).toBe(true);
  }

  async function buildSpec(entityType: 'deals' | 'persons' | 'organizations' | 'activities', fields: PipedriveField[]) {
    mockClient.getFields.mockResolvedValue(fields);
    return buildPipedriveJsonTableSpec(
      { wsId: entityType, remoteId: [entityType] },
      entityType,
      mockClient as unknown as PipedriveApiClient,
    );
  }

  it('validates a deal with a flat numeric `value` and null mrr/arr/acv (v2 flat money)', async () => {
    const spec = await buildSpec('deals', [
      makeField({ field_code: 'title', field_type: 'varchar' }),
      makeField({ field_code: 'value', field_type: 'monetary' }),
      makeField({ field_code: 'mrr', field_type: 'monetary' }),
      makeField({ field_code: 'arr', field_type: 'monetary' }),
      makeField({ field_code: 'acv', field_type: 'monetary' }),
    ]);
    // `currency` is a root-level key not modelled in dealFields — it must pass as an extra property.
    expectValid(spec.schema, {
      title: '[Sample] Damone',
      value: 15000,
      currency: 'CAD',
      mrr: null,
      arr: null,
      acv: null,
    });
  });

  it('validates an activity with null location, a participants array, and a numeric project_id', async () => {
    const spec = await buildSpec('activities', [
      makeField({ field_code: 'subject', field_type: 'varchar' }),
      makeField({ field_code: 'location', field_type: 'address' }),
      makeField({ field_code: 'participants', field_type: 'varchar' }),
      makeField({ field_code: 'project_id', field_type: 'varchar' }),
    ]);
    expectValid(spec.schema, {
      subject: '[Sample] Context call',
      location: null,
      participants: [{ person_id: 4, primary: true }],
      project_id: 1,
    });
    // An empty participants array (seen in the data) must also validate.
    expectValid(spec.schema, { subject: 'x', location: null, participants: [], project_id: null });
  });

  it('validates a person with an emails array and an empty phones array', async () => {
    const spec = await buildSpec('persons', [
      makeField({ field_code: 'name', field_type: 'varchar' }),
      makeField({ field_code: 'emails', field_type: 'varchar' }),
      makeField({ field_code: 'phones', field_type: 'phone' }),
    ]);
    expectValid(spec.schema, {
      name: '[Sample] Otto Miller',
      emails: [{ label: 'work', value: 'otto.miller@itablee.eu', primary: true }],
      phones: [],
    });
  });

  it('validates an organization with a null address', async () => {
    const spec = await buildSpec('organizations', [
      makeField({ field_code: 'name', field_type: 'varchar' }),
      makeField({ field_code: 'address', field_type: 'address' }),
    ]);
    expectValid(spec.schema, { name: '[Sample] iTable', address: null });
  });

  it('validates an activity whose `type` is outside the discovered options (Pipedrive default/deleted type)', async () => {
    const spec = await buildSpec('activities', [
      makeField({ field_code: 'subject', field_type: 'varchar' }),
      makeField({
        field_code: 'type',
        field_type: 'enum',
        options: [
          { id: 'call', label: 'Call' },
          { id: 'meeting', label: 'Meeting' },
        ],
      }),
    ]);
    // `email`/`task`/`lunch` are Pipedrive defaults absent from this account's option list, yet
    // verbatim activities still reference them. The open enum must accept the out-of-set value.
    expectValid(spec.schema, { subject: 'x', type: 'email' });
  });

  it('validates a deal with a custom time field stored as a {value, timezone_id, timezone_name} object', async () => {
    const spec = await buildSpec('deals', [
      makeField({ field_code: 'title', field_type: 'varchar' }),
      makeField({
        field_code: 'abc123timehash',
        field_name: 'NBI due time',
        field_type: 'time',
        is_custom_field: true,
      }),
    ]);
    expectValid(spec.schema, {
      title: '[Sample] Deal',
      custom_fields: { abc123timehash: { value: '12:00:00', timezone_id: 272, timezone_name: 'Asia/Singapore' } },
    });
  });

  it('validates a person whose picture_id is a bare numeric id (v2 shape)', async () => {
    const spec = await buildSpec('persons', [
      makeField({ field_code: 'name', field_type: 'varchar' }),
      makeField({ field_code: 'picture_id', field_type: 'picture', is_custom_field: false }),
    ]);
    expectValid(spec.schema, { name: '[Sample] Otto', picture_id: 183 });
  });

  it('validates a v1 lead with a custom monetary (bare number) and custom set (comma-joined string)', async () => {
    // Leads use the v1 API: custom monetary is a bare number and custom set is a CSV id string,
    // and custom fields are placed flat (top level), not under a `custom_fields` object.
    mockClient.getFields.mockResolvedValue([
      makeField({
        field_code: 'moneyhash',
        field_name: 'Enterprise Value',
        field_type: 'monetary',
        is_custom_field: true,
      }),
      makeField({
        field_code: 'sethash',
        field_name: 'Tags',
        field_type: 'set',
        is_custom_field: true,
        options: [{ id: 1162 }, { id: 1206 }],
      }),
    ]);
    const spec = await buildPipedriveJsonTableSpec(
      { wsId: 'leads', remoteId: ['leads'] },
      'leads',
      mockClient as unknown as PipedriveApiClient,
    );
    expectValid(spec.schema, { title: '[Sample] Lead', moneyhash: 110000000, sethash: '1162,1206' });
  });
});
