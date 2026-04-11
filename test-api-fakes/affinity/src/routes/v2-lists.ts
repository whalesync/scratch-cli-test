import { Request, Response, Router } from "express";
import {
  AffinityField,
  AffinityFieldType,
  AffinityListEntry,
  store,
} from "../store";

const router = Router();

const PAGE_SIZE = 100;

const VALID_FIELD_TYPES: ReadonlySet<AffinityFieldType> = new Set([
  "enriched",
  "global",
  "list",
  "relationship-intelligence",
]);

/**
 * Slice an array by a base64-encoded numeric offset cursor and build the
 * Affinity-style `pagination: { prevUrl, nextUrl }` envelope.
 *
 * The connector parses `nextUrl` to extract the `cursor` query param, so the
 * URL has to be a valid absolute URL pointing back at this same endpoint.
 */
function paginate<T>(
  req: Request,
  items: T[],
): { data: T[]; pagination: { prevUrl: string | null; nextUrl: string | null } } {
  let startIndex = 0;
  const cursorParam = req.query.cursor;
  if (typeof cursorParam === "string") {
    try {
      startIndex = parseInt(Buffer.from(cursorParam, "base64").toString("utf-8"), 10);
      if (isNaN(startIndex) || startIndex < 0) startIndex = 0;
    } catch {
      startIndex = 0;
    }
  }

  const requestedLimit = parseInt(String(req.query.limit ?? PAGE_SIZE), 10);
  const limit = Math.min(isNaN(requestedLimit) ? PAGE_SIZE : requestedLimit, PAGE_SIZE);

  const page = items.slice(startIndex, startIndex + limit);

  const nextStart = startIndex + limit;
  const hasNext = nextStart < items.length;
  const prevStart = Math.max(0, startIndex - limit);
  const hasPrev = startIndex > 0;

  const buildUrl = (offset: number): string => {
    // Reconstruct the request URL with a fresh cursor. We strip the existing
    // cursor from the query string and append the new one.
    const protocol = req.protocol;
    const host = req.get("host");
    const path = req.path;

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(req.query)) {
      if (key === "cursor") continue;
      if (Array.isArray(value)) {
        for (const v of value) params.append(key, String(v));
      } else if (value !== undefined) {
        params.append(key, String(value));
      }
    }
    params.append("cursor", Buffer.from(String(offset)).toString("base64"));
    return `${protocol}://${host}${path}?${params.toString()}`;
  };

  return {
    data: page,
    pagination: {
      prevUrl: hasPrev ? buildUrl(prevStart) : null,
      nextUrl: hasNext ? buildUrl(nextStart) : null,
    },
  };
}

/** Parse `?fieldTypes=a&fieldTypes=b` (axios serializes arrays as repeated keys). */
function parseFieldTypeFilter(req: Request): Set<AffinityFieldType> | null {
  const raw = req.query.fieldTypes;
  if (raw === undefined) return null;
  const values = Array.isArray(raw) ? raw : [raw];
  const filter = new Set<AffinityFieldType>();
  for (const value of values) {
    const str = String(value);
    if (VALID_FIELD_TYPES.has(str as AffinityFieldType)) {
      filter.add(str as AffinityFieldType);
    }
  }
  return filter.size > 0 ? filter : null;
}

/** Filter the fields array on a list entry's entity to match the requested types. */
function filterEntryFields(
  entry: AffinityListEntry,
  filter: Set<AffinityFieldType> | null,
): AffinityListEntry {
  if (!filter) {
    // No filter → strip field data entirely (matches the real API: when no
    // fieldTypes/fieldIds is passed, list entries come back without fields).
    return {
      ...entry,
      entity: { ...entry.entity, fields: [] as AffinityField[] },
    };
  }
  const filtered = entry.entity.fields.filter((f) => filter.has(f.type));
  return {
    ...entry,
    entity: { ...entry.entity, fields: filtered },
  };
}

// ---- GET /v2/lists ----

router.get("/v2/lists", (req, res) => {
  const lists = store.listLists();
  const result = paginate(req, lists);
  res.json(result);
});

// ---- GET /v2/lists/{listId} ----

router.get("/v2/lists/:listId", (req, res) => {
  const listId = parseInt(req.params.listId, 10);
  const list = store.getList(listId);
  if (!list) {
    res.status(404).json({ errors: [{ code: "not_found", message: `List ${listId} not found` }] });
    return;
  }
  res.json(list);
});

// ---- GET /v2/lists/{listId}/fields ----

router.get("/v2/lists/:listId/fields", (req, res) => {
  const listId = parseInt(req.params.listId, 10);
  if (!store.getList(listId)) {
    res.status(404).json({ errors: [{ code: "not_found", message: `List ${listId} not found` }] });
    return;
  }
  const fields = store.getFieldsForList(listId);
  const result = paginate(req, fields);
  res.json(result);
});

// ---- GET /v2/lists/{listId}/list-entries ----

router.get("/v2/lists/:listId/list-entries", (req, res) => {
  const listId = parseInt(req.params.listId, 10);
  if (!store.getList(listId)) {
    res.status(404).json({ errors: [{ code: "not_found", message: `List ${listId} not found` }] });
    return;
  }

  const fieldTypeFilter = parseFieldTypeFilter(req);
  const entries = store.getEntries(listId).map((e) => filterEntryFields(e, fieldTypeFilter));
  const result = paginate(req, entries);
  res.json(result);
});

// ---- GET /v2/lists/{listId}/list-entries/{listEntryId} ----

router.get("/v2/lists/:listId/list-entries/:entryId", (req, res) => {
  const listId = parseInt(req.params.listId, 10);
  const entryId = parseInt(req.params.entryId, 10);
  if (!store.getList(listId)) {
    res.status(404).json({ errors: [{ code: "not_found", message: `List ${listId} not found` }] });
    return;
  }
  const entry = store.getEntry(listId, entryId);
  if (!entry) {
    res
      .status(404)
      .json({ errors: [{ code: "not_found", message: `List entry ${entryId} not found in list ${listId}` }] });
    return;
  }
  const fieldTypeFilter = parseFieldTypeFilter(req);
  res.json(filterEntryFields(entry, fieldTypeFilter));
});

// ---- GET /v2/auth/whoami (cheap connection probe) ----

router.get("/v2/auth/whoami", (_req, res) => {
  res.json({
    tenant: { id: 99999, name: "Fake Tenant", subdomain: "fake" },
    user: { id: 1, firstName: "Fake", lastName: "User", email: "fake@example.com" },
    grant: { type: "api_key", scope: "api", createdAt: "2025-01-01T00:00:00.000-08:00" },
  });
});

export default router;
