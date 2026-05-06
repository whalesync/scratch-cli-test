# JSON Schema Validator Fixtures

Each subdirectory is one test case for the `enforce_schema_jsonschema` built-in validator.

## Structure

```
<case>/
  schema.json   — schema.json wrapper ({ "schema": { … } }) used as validator input
  pass.json     — record that must produce zero violations
  fail.json     — record that must produce ≥ 1 violation
```

The test harness in `tests/jsonschema_fixtures.rs` walks every non-`gap_*` subdirectory,
runs the validator on both files, and asserts the expected outcome.

## Cases

| Directory | What is tested |
|---|---|
| `type_string` | String field rejects a number value |
| `type_number` | Number field rejects a string value |
| `type_boolean` | Boolean field rejects a string value |
| `type_object` | Object field rejects a primitive string |
| `type_array` | Array field rejects a primitive string |
| `array_items_type` | Array of strings rejects an item of wrong type |
| `format_date` | `format: date` rejects a non-date string |
| `format_datetime` | `format: date-time` rejects a non-datetime string |
| `format_email` | `format: email` rejects a non-email string |
| `single_select_enum` | `enum` list rejects a value not in the list |
| `multi_select_enum` | `items.enum` rejects an array item not in the list |
| `additional_property_unknown` | `additionalProperties: false` rejects an unknown column |
| `required_missing` | `required` rejects a record where the key is absent |
| `null_not_allowed` | Non-nullable field rejects a null value |

## Known gaps (gap_* directories)

These directories document cases where pure JSON Schema validation is **insufficient**
and the existing hand-rolled `enforce_schema` checks must remain alongside it.

| Directory | Gap |
|---|---|
| `gap_required_null` | JSONSchema `required` only checks key presence; `{"name": null}` passes. Our custom code catches null as missing. |
| `gap_required_empty_string` | JSONSchema has no concept of "empty string = missing"; `{"name": ""}` passes. Our custom code catches this. |

The gap test cases include a `tricky.json` (the record that slips past JSONSchema) and
assert that the JSONSchema validator produces **no violations** — confirming the gap
is real and the custom code is still needed.
