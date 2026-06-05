/**
 * RFC 6902 JSON Patch — applier (full standard).
 *
 * The TypeScript mirror of the Rust applier in
 * `scratch-git-2/src/shared/json_patch.rs`. The two MUST stay semantically
 * equivalent — the shared parity corpus in
 * `scratch-git-2/src/shared/testdata/json_patch/` is exercised by both engines
 * (see `__tests__/json-patch.spec.ts`).
 *
 * The defining win over RFC 7396 (`applyJsonMergePatch`) is that `null` is an
 * ordinary value here, not the deletion sentinel: `{"op":"add","path":"/f",
 * "value":null}` sets null; `{"op":"remove","path":"/f"}` deletes (DEV-10237).
 *
 * The server only ever *applies* patches (the differ that emits them is
 * Rust-only, at accept time), but we implement the complete standard — all six
 * ops with full RFC 6901 JSON Pointer addressing including array indices — so we
 * stay interoperable with externally-authored patches and so the Appendix A
 * golden vectors pass.
 */

export type JsonValue = unknown;

export type JsonPatchOp =
  | { op: 'add'; path: string; value: JsonValue }
  | { op: 'remove'; path: string }
  | { op: 'replace'; path: string; value: JsonValue }
  | { op: 'move'; from: string; path: string }
  | { op: 'copy'; from: string; path: string }
  | { op: 'test'; path: string; value: JsonValue };

function isPlainObject(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(object: Record<string, JsonValue>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

// ── RFC 6901 JSON Pointer ────────────────────────────────────────────────────

/**
 * Decode a single RFC 6901 reference token: `~1` → `/` then `~0` → `~`. Order is
 * mandated by RFC 6901 §4 so `~01` decodes to `~1`, not `/`.
 */
function decodePointerToken(token: string): string {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

/**
 * Parse a JSON Pointer into its decoded reference tokens. The empty string is
 * the whole document (empty token list); any non-empty pointer must begin `/`.
 */
function parsePointer(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) {
    throw new Error(`invalid JSON pointer (must be empty or start with '/'): ${JSON.stringify(pointer)}`);
  }
  return pointer.slice(1).split('/').map(decodePointerToken);
}

/**
 * Parse an array reference token per RFC 6901 / RFC 6902 array semantics.
 * `allowEnd` permits `-` (append) and an index equal to `len` (append). Leading
 * zeros are rejected.
 */
function parseArrayIndex(token: string, len: number, allowEnd: boolean): number {
  if (token === '-') {
    if (allowEnd) return len;
    throw new Error(`array index '-' is only valid as an insertion/append target`);
  }
  if (token.length > 1 && token.startsWith('0')) {
    throw new Error(`invalid array index with leading zero: ${JSON.stringify(token)}`);
  }
  if (!/^[0-9]+$/.test(token)) {
    throw new Error(`invalid array index: ${JSON.stringify(token)}`);
  }
  const index = Number(token);
  const max = allowEnd ? len : len - 1;
  if (index > max || (!allowEnd && len === 0)) {
    throw new Error(`array index ${index} out of bounds (len ${len}, allowEnd ${allowEnd})`);
  }
  return index;
}

// ── op validation (mirrors serde's discriminated deserialize) ────────────────

function parseOp(raw: JsonValue): JsonPatchOp {
  if (!isPlainObject(raw)) {
    throw new Error(`each op must be an object; got ${JSON.stringify(raw)}`);
  }
  const op = raw.op;
  const requireString = (field: string): string => {
    const value = raw[field];
    if (typeof value !== 'string') {
      throw new Error(`op ${JSON.stringify(op)} requires a string "${field}"`);
    }
    return value;
  };
  const requireValue = (): JsonValue => {
    if (!hasOwn(raw, 'value')) {
      throw new Error(`op ${JSON.stringify(op)} requires a "value"`);
    }
    return raw.value;
  };
  switch (op) {
    case 'add':
      return { op: 'add', path: requireString('path'), value: requireValue() };
    case 'remove':
      return { op: 'remove', path: requireString('path') };
    case 'replace':
      return { op: 'replace', path: requireString('path'), value: requireValue() };
    case 'move':
      return { op: 'move', from: requireString('from'), path: requireString('path') };
    case 'copy':
      return { op: 'copy', from: requireString('from'), path: requireString('path') };
    case 'test':
      return { op: 'test', path: requireString('path'), value: requireValue() };
    default:
      throw new Error(`unknown RFC 6902 op: ${JSON.stringify(op)}`);
  }
}

// ── apply ────────────────────────────────────────────────────────────────────

/**
 * Apply a sequence of RFC 6902 operations to `target`, returning the new
 * document. The original is not mutated. Operations apply in order; any failure
 * (missing target, failed `test`, out-of-bounds index, malformed op) throws and
 * the whole patch fails — callers needing atomicity discard the thrown call.
 */
export function applyJsonPatch(target: JsonValue, ops: readonly JsonValue[]): JsonValue {
  // `add ""` / `replace ""` can replace the whole document, so thread the root
  // through a holder rather than relying on in-place mutation alone.
  const holder = { root: structuredClone(target) };
  ops.forEach((rawOp, index) => {
    const op = parseOp(rawOp);
    try {
      applyOne(holder, op);
    } catch (err) {
      throw new Error(`op[${index}] (${op.path}) failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  return holder.root;
}

function applyOne(holder: { root: JsonValue }, op: JsonPatchOp): void {
  switch (op.op) {
    case 'add':
      // Clone the inserted value (matching the Rust applier's `value.clone()`)
      // so we never alias `op.value` into the result — a later op targeting
      // inside this subtree must not mutate the caller's patch array.
      addAt(holder, op.path, structuredClone(op.value));
      return;
    case 'remove':
      removeAt(holder, op.path);
      return;
    case 'replace':
      replaceAt(holder, op.path, structuredClone(op.value));
      return;
    case 'move': {
      if (isProperPrefix(op.from, op.path)) {
        throw new Error(`'from' (${op.from}) MUST NOT be a proper prefix of 'path' (${op.path})`);
      }
      const value = removeAt(holder, op.from);
      addAt(holder, op.path, value);
      return;
    }
    case 'copy': {
      const source = resolve(holder.root, parsePointer(op.from));
      if (source === undefined) {
        throw new Error(`'from' location does not exist: ${op.from}`);
      }
      addAt(holder, op.path, structuredClone(source));
      return;
    }
    case 'test': {
      const actual = resolve(holder.root, parsePointer(op.path));
      if (actual === undefined) {
        throw new Error(`'test' target does not exist: ${op.path}`);
      }
      if (!deepEqual(actual, op.value)) {
        throw new Error(`'test' failed at ${op.path}`);
      }
      return;
    }
  }
}

// "No value at this location" is signalled by `undefined`: JSON values parsed
// from the wire are never `undefined` (an absent member is just absent; an
// explicit null is `null`), so it is an unambiguous missing sentinel. The return
// type is just `JsonValue` (which already subsumes `undefined`); callers test
// `=== undefined`.
function resolve(root: JsonValue, tokens: string[]): JsonValue {
  let current: JsonValue = root;
  for (const token of tokens) {
    if (Array.isArray(current)) {
      let index: number;
      try {
        index = parseArrayIndex(token, current.length, false);
      } catch {
        return undefined;
      }
      if (index >= current.length) return undefined;
      current = current[index];
    } else if (isPlainObject(current)) {
      if (!hasOwn(current, token)) return undefined;
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Navigate to the parent container of the final token, erroring if any intermediate is missing/not a container. */
function resolveParent(root: JsonValue, parentTokens: string[]): JsonValue {
  let current: JsonValue = root;
  for (const token of parentTokens) {
    if (Array.isArray(current)) {
      const index = parseArrayIndex(token, current.length, false);
      if (index >= current.length) {
        throw new Error(`path traverses out-of-bounds array index ${JSON.stringify(token)}`);
      }
      current = current[index];
    } else if (isPlainObject(current)) {
      if (!hasOwn(current, token)) {
        throw new Error(`path traverses missing object key ${JSON.stringify(token)}`);
      }
      current = current[token];
    } else {
      throw new Error(`path traverses non-container at ${JSON.stringify(token)}`);
    }
  }
  return current;
}

function addAt(holder: { root: JsonValue }, path: string, value: JsonValue): void {
  const tokens = parsePointer(path);
  const last = tokens.pop();
  if (last === undefined) {
    holder.root = value;
    return;
  }
  const parent = resolveParent(holder.root, tokens);
  if (Array.isArray(parent)) {
    parent.splice(parseArrayIndex(last, parent.length, true), 0, value);
  } else if (isPlainObject(parent)) {
    parent[last] = value;
  } else {
    throw new Error(`cannot add member ${JSON.stringify(last)} to non-container at ${path}`);
  }
}

function removeAt(holder: { root: JsonValue }, path: string): JsonValue {
  const tokens = parsePointer(path);
  const last = tokens.pop();
  if (last === undefined) {
    throw new Error(`cannot remove the whole document (empty path)`);
  }
  const parent = resolveParent(holder.root, tokens);
  if (Array.isArray(parent)) {
    return parent.splice(parseArrayIndex(last, parent.length, false), 1)[0];
  }
  if (isPlainObject(parent)) {
    if (!hasOwn(parent, last)) {
      throw new Error(`remove target does not exist: ${path}`);
    }
    const removed = parent[last];
    delete parent[last];
    return removed;
  }
  throw new Error(`cannot remove member ${JSON.stringify(last)} from non-container at ${path}`);
}

function replaceAt(holder: { root: JsonValue }, path: string, value: JsonValue): void {
  const tokens = parsePointer(path);
  const last = tokens.pop();
  if (last === undefined) {
    holder.root = value;
    return;
  }
  const parent = resolveParent(holder.root, tokens);
  if (Array.isArray(parent)) {
    parent[parseArrayIndex(last, parent.length, false)] = value;
  } else if (isPlainObject(parent)) {
    if (!hasOwn(parent, last)) {
      throw new Error(`replace target does not exist: ${path}`);
    }
    parent[last] = value;
  } else {
    throw new Error(`cannot replace member ${JSON.stringify(last)} in non-container at ${path}`);
  }
}

/** Token-granular proper-prefix test (so `move` can reject moving into a child). */
function isProperPrefix(prefix: string, path: string): boolean {
  let prefixTokens: string[];
  let pathTokens: string[];
  try {
    prefixTokens = parsePointer(prefix);
    pathTokens = parsePointer(path);
  } catch {
    return false;
  }
  return prefixTokens.length < pathTokens.length && prefixTokens.every((token, i) => token === pathTokens[i]);
}

/** Structural JSON equality (order-independent for objects) for the `test` op. */
function deepEqual(a: JsonValue, b: JsonValue): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, i) => deepEqual(value, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    return aKeys.length === bKeys.length && aKeys.every((key) => hasOwn(b, key) && deepEqual(a[key], b[key]));
  }
  return false;
}

// ── dual-read dialect dispatch ───────────────────────────────────────────────

/**
 * Whether a stored/wire `Update` patch body is the RFC 6902 (v2) dialect rather
 * than the legacy RFC 7396 (v1) merge-patch dialect. They are structurally
 * disjoint — a 6902 patch is always a JSON array, a 7396 merge patch always a
 * JSON object — so reconstruction picks the applier by shape, mirroring the Rust
 * `json_patch::is_json_patch_dialect`.
 */
export function isJsonPatchDialect(patch: JsonValue): boolean {
  return Array.isArray(patch);
}
