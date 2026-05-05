/**
 * Helpers for the Attio CRUD round-trip integration spec.
 *
 * Two responsibilities:
 *
 *   1. **`buildTestValues(objectSlug, ownerMemberId, variant)`** — produce a
 *      write-shape `values` map covering every relevant field type for a
 *      given standard object. Universal types (text/number/checkbox/...)
 *      live on the `spinner_test_<type>_field` custom attrs that the
 *      bootstrap script provisioned. Object-specific types (status on deals,
 *      personal-name on people, etc.) live on system built-ins.
 *
 *   2. **`expectFieldRoundTrip(written, read, attributeType)`** — assert that
 *      the array we wrote came back as the expected read shape after
 *      stripping the universal metadata envelope and accounting for the
 *      handful of asymmetric types (`select`, `status`).
 *
 * Together these let each CRUD test cover *every field type* without
 * multiplying tests by type.
 */

const ENVELOPE_KEYS = new Set(['attribute_type', 'active_from', 'active_until', 'created_by_actor']);

/** The `variant` flag lets create / update tests pick distinct values so we
 * can assert that updates actually changed something. */
export type ValueVariant = 'a' | 'b';

interface BuildOptions {
  ownerMemberId: string;
  /**
   * Short unique suffix appended to fields with uniqueness constraints
   * (`domains` on companies, `email_addresses` on people). Different tests
   * in the same run create their own records with their own suffix, so
   * concurrent or sequential tests don't collide on uniqueness violations.
   * Pass a fresh UUID-ish string per test.
   */
  uniqueSuffix: string;
}

/**
 * Build a write-shape `values` map for one of the three standard objects.
 *
 * Universal types come from the `spinner_test_<type>_field` custom attrs the
 * bootstrap script provisioned. Object-specific types (status, personal-name,
 * email-address, phone-number, domain, actor-reference) come from each
 * object's built-ins, where available.
 *
 * `deals` requires `name + stage + owner` on creation, so those are always
 * populated; `companies` and `people` have no required fields.
 */
export function buildTestValues(
  objectSlug: 'companies' | 'people' | 'deals',
  variant: ValueVariant,
  opts: BuildOptions,
): Record<string, unknown[]> {
  const values: Record<string, unknown[]> = {};

  // --- Universal custom attrs (every object has these from the bootstrap) ---
  values.spinner_test_text_field = [{ value: variant === 'a' ? 'Round-trip A' : 'Round-trip B' }];
  values.spinner_test_number_field = [{ value: variant === 'a' ? 42 : 99 }];
  values.spinner_test_checkbox_field = [{ value: variant === 'a' ? true : false }];
  values.spinner_test_rating_field = [{ value: variant === 'a' ? 4 : 2 }];
  values.spinner_test_select_field = [{ option: variant === 'a' ? 'Alpha' : 'Beta' }];
  values.spinner_test_date_field = [{ value: variant === 'a' ? '2026-05-05' : '2026-06-15' }];
  // currency: the write shape accepts `currency_value` only; `currency_code`
  // is auto-populated from the attribute's default and is rejected on write.
  values.spinner_test_currency_field = [{ currency_value: variant === 'a' ? 1234.56 : 9876.54 }];

  // --- Object-specific built-ins ---
  switch (objectSlug) {
    case 'companies': {
      values.name = [{ value: variant === 'a' ? 'Spinner Roundtrip Co A' : 'Spinner Roundtrip Co B' }];
      // domain: write `{ domain }` only; `root_domain` is derived and rejected.
      // `domains` is unique workspace-wide — suffix to avoid collisions between
      // concurrent / sequential tests that each create their own record.
      values.domains = [{ domain: `roundtrip-${variant}-${opts.uniqueSuffix}.example.com` }];
      break;
    }
    case 'people': {
      values.name = [
        {
          first_name: 'Spinner',
          last_name: variant === 'a' ? 'RoundtripA' : 'RoundtripB',
          full_name: variant === 'a' ? 'Spinner RoundtripA' : 'Spinner RoundtripB',
        },
      ];
      // email-address: write `email_address` only; the four derived
      // *_domain / *_local_specifier / original_email_address fields are
      // rejected on write. Email is unique on people, so suffix.
      values.email_addresses = [{ email_address: `roundtrip-${variant}-${opts.uniqueSuffix}@example.com` }];
      // phone-number: write key is `original_phone_number` (NOT `phone_number`).
      // Use real-shaped numbers — Attio runs basic E.164 validation.
      values.phone_numbers = [
        {
          original_phone_number: variant === 'a' ? '+14155551111' : '+14155552222',
          country_code: 'US',
        },
      ];
      break;
    }
    case 'deals': {
      values.name = [{ value: variant === 'a' ? 'Spinner Roundtrip Deal A' : 'Spinner Roundtrip Deal B' }];
      values.stage = [{ status: variant === 'a' ? 'Lead' : 'In Progress' }];
      values.owner = [{ referenced_actor_type: 'workspace-member', referenced_actor_id: opts.ownerMemberId }];
      values.value = [{ currency_value: variant === 'a' ? 50000 : 75000 }];
      break;
    }
  }

  return values;
}

/**
 * Assert a single field's read-shape array matches what we wrote, allowing
 * for the universal metadata envelope and the handful of types where read
 * and write shapes disagree.
 */
export function expectFieldRoundTrip(written: unknown[], read: unknown[]): void {
  expect(read).toHaveLength(written.length);
  for (let i = 0; i < written.length; i++) {
    const w = written[i] as Record<string, unknown>;
    const r = stripEnvelope(read[i] as Record<string, unknown>);
    const attributeType = (read[i] as { attribute_type?: string }).attribute_type;

    if (attributeType === 'select') {
      // Read-shape: { option: { id: {...}, title: 'Alpha', is_archived } }
      // Write-shape: { option: 'Alpha' }
      const readOption = r.option as { title?: unknown };
      expect(readOption?.title).toBe(w.option);
    } else if (attributeType === 'status') {
      // Same pattern as select.
      const readStatus = r.status as { title?: unknown };
      expect(readStatus?.title).toBe(w.status);
    } else {
      // Symmetric: every key the caller wrote should be present and equal.
      expect(r).toMatchObject(w);
    }
  }
}

/**
 * Walk a written `values` map and assert each key round-tripped through the
 * read shape. Read entries for keys we didn't write are ignored — the read
 * may carry extra system-populated fields we never touched.
 */
export function expectValuesRoundTrip(written: Record<string, unknown[]>, read: Record<string, unknown[]>): void {
  for (const [apiSlug, writtenArray] of Object.entries(written)) {
    const readArray = read[apiSlug];
    expect(readArray).toBeDefined();
    expectFieldRoundTrip(writtenArray, readArray);
  }
}

function stripEnvelope(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!ENVELOPE_KEYS.has(k)) out[k] = v;
  }
  return out;
}
