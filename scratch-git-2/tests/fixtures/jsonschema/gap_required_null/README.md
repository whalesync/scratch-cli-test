# Gap: required NON-nullable field present but null

JSONSchema `required` only checks that the key **exists** in the object.
`{ "title": null }` satisfies `required: ["title"]` because the key is present,
and `enforce_schema` skips JSONSchema conformance errors whose failing value is
`null` (a verbatim null is the service's "no value", not malformed data). So
pure JSONSchema produces no violation here.

The hand-rolled `enforce_schema` required check fills that gap — but only for a
field whose schema does **not** permit null. `title` here is `type: "string"`
(non-nullable), so a present null/blank counts as missing and is flagged.

This is the regression guard for that check. (A required field that *does*
permit null — `type: ["string", "null"]` or an `anyOf`/`oneOf` null branch, e.g.
Intercom's nullable-but-required fields — legitimately holds a verbatim null and
is intentionally **not** flagged; see the `required_nullable_*` unit tests in
`builtin.rs`.)
