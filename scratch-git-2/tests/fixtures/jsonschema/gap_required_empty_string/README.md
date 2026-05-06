# Gap: required field present but empty string

JSONSchema has no concept of "empty string = missing". `{ "title": "" }` is a
valid string and satisfies both `required: ["title"]` and `type: "string"`.

`tricky.json` passes JSONSchema validation — the test asserts zero violations
from the JSONSchema validator, confirming this gap is real.

The existing hand-rolled `enforce_schema` required check catches this case
by treating `""` as "not provided". Both validators must run together.
