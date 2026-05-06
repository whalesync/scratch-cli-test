# Gap: required field present but null

JSONSchema `required` only checks that the key **exists** in the object.
`{ "title": null }` satisfies `required: ["title"]` because the key is present.

`tricky.json` passes JSONSchema validation — the test asserts zero violations
from the JSONSchema validator, confirming this gap is real.

The existing hand-rolled `enforce_schema` required check catches this case
by treating null as "missing". Both validators must run together.
