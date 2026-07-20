import { Router } from "express";
import { store, HubspotRecord, isPublishedQuoteStatus } from "../store";

const router = Router();

const PAGE_SIZE = 100;

/**
 * Serialize a record for API response.
 * Filters properties to only include requested ones (if specified).
 */
function serializeRecord(
  record: HubspotRecord,
  requestedProperties?: string[],
  requestedAssociations?: string[],
): Record<string, unknown> {
  let properties = record.properties;
  if (requestedProperties && requestedProperties.length > 0) {
    const filtered: Record<string, string | null> = {};
    for (const prop of requestedProperties) {
      if (prop in properties) {
        filtered[prop] = properties[prop];
      }
    }
    // Always include system properties
    filtered.hs_object_id = properties.hs_object_id;
    filtered.createdate = properties.createdate;
    filtered.lastmodifieddate = properties.lastmodifieddate;
    properties = filtered;
  }

  const result: Record<string, unknown> = {
    id: record.id,
    properties,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    archived: record.archived,
  };

  // Include associations if requested
  if (
    requestedAssociations &&
    requestedAssociations.length > 0 &&
    record.associations
  ) {
    const filteredAssoc: Record<string, unknown> = {};
    for (const assocType of requestedAssociations) {
      if (record.associations[assocType]) {
        filteredAssoc[assocType] = record.associations[assocType];
      }
    }
    if (Object.keys(filteredAssoc).length > 0) {
      result.associations = filteredAssoc;
    }
  } else if (
    record.associations &&
    Object.keys(record.associations).length > 0
  ) {
    result.associations = record.associations;
  }

  return result;
}

function parseCommaSeparated(value: unknown): string[] {
  if (!value || typeof value !== "string") return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// --- Properties API ---

router.get("/properties/:objectType", (req, res) => {
  const { objectType } = req.params;
  const properties = store.getProperties(objectType);
  res.json({ results: properties });
});

// --- Schemas API (Custom Objects) ---

router.get("/schemas", (_req, res) => {
  res.json({ results: store.customObjectSchemas });
});

// --- Records CRUD ---

// List records with pagination
router.get("/objects/:objectType", (req, res) => {
  const { objectType } = req.params;
  const { after, limit } = req.query;
  const requestedProperties = parseCommaSeparated(req.query.properties);
  const requestedAssociations = parseCommaSeparated(req.query.associations);

  const pageSize = limit
    ? Math.min(parseInt(String(limit), 10), PAGE_SIZE)
    : PAGE_SIZE;
  const allRecords = store.listRecords(objectType);

  // Find start index based on cursor
  let startIndex = 0;
  if (after) {
    const afterId = String(after);
    const idx = allRecords.findIndex((r) => r.id === afterId);
    if (idx !== -1) {
      startIndex = idx + 1;
    }
  }

  const page = allRecords.slice(startIndex, startIndex + pageSize);
  const hasMore = startIndex + pageSize < allRecords.length;

  const response: Record<string, unknown> = {
    results: page.map((r) =>
      serializeRecord(r, requestedProperties, requestedAssociations),
    ),
  };

  if (hasMore) {
    response.paging = {
      next: {
        after: page[page.length - 1].id,
      },
    };
  }

  res.json(response);
});

// Get single record
router.get("/objects/:objectType/:recordId", (req, res) => {
  const { objectType, recordId } = req.params;
  const requestedProperties = parseCommaSeparated(req.query.properties);
  const requestedAssociations = parseCommaSeparated(req.query.associations);

  const record = store.getRecord(objectType, recordId);
  if (!record || record.archived) {
    res.status(404).json({
      status: "error",
      message: `resource not found`,
      correlationId: "fake-correlation-id",
      category: "OBJECT_NOT_FOUND",
    });
    return;
  }

  res.json(serializeRecord(record, requestedProperties, requestedAssociations));
});

// Batch read records
router.post("/objects/:objectType/batch/read", (req, res) => {
  const { objectType } = req.params;
  const { inputs, properties: requestedProperties } = req.body;

  const results: Array<Record<string, unknown>> = [];
  for (const input of inputs) {
    const record = store.getRecord(objectType, input.id);
    if (record && !record.archived) {
      results.push(serializeRecord(record, requestedProperties));
    }
  }

  res.json({ status: "COMPLETE", results });
});

// --- CRM Search API (incremental pull) ---

const SEARCH_PAGE_SIZE = 100;

interface SearchFilter {
  propertyName: string;
  operator: string;
  value: string;
}

/**
 * Compare a record's date-valued property (stored as an ISO string) against the
 * filter value (epoch milliseconds, as the connector sends). Returns false when
 * the property is absent so a record without the modified field never matches.
 */
function recordMatchesFilter(
  record: HubspotRecord,
  filter: SearchFilter,
): boolean {
  const raw = record.properties[filter.propertyName];
  if (raw === null || raw === undefined) return false;
  const recordMs = Date.parse(raw);
  const filterMs = Number(filter.value);
  if (Number.isNaN(recordMs) || Number.isNaN(filterMs)) return false;
  switch (filter.operator) {
    case "GTE":
      return recordMs >= filterMs;
    case "GT":
      return recordMs > filterMs;
    case "LTE":
      return recordMs <= filterMs;
    case "LT":
      return recordMs < filterMs;
    case "EQ":
      return recordMs === filterMs;
    default:
      return true;
  }
}

/**
 * Minimal model of `POST /crm/v3/objects/{type}/search`: AND-filter the first
 * filter group, sort by the first sort spec, and offset-paginate via a numeric
 * `after` cursor. Unlike the list endpoint, the Search API never returns
 * `associations` — the response only carries `properties`.
 */
router.post("/objects/:objectType/search", (req, res) => {
  const { objectType } = req.params;
  const {
    filterGroups,
    sorts,
    properties: requestedProperties,
    limit,
    after,
  } = req.body ?? {};

  const pageSize = limit
    ? Math.min(parseInt(String(limit), 10), 200)
    : SEARCH_PAGE_SIZE;

  let records = store.listRecords(objectType);

  const filters: SearchFilter[] = filterGroups?.[0]?.filters ?? [];
  for (const filter of filters) {
    records = records.filter((r) => recordMatchesFilter(r, filter));
  }

  const sort = sorts?.[0];
  if (sort) {
    const direction = sort.direction === "DESCENDING" ? -1 : 1;
    records = [...records].sort((a, b) => {
      const av = Date.parse(a.properties[sort.propertyName] ?? "") || 0;
      const bv = Date.parse(b.properties[sort.propertyName] ?? "") || 0;
      // Stable tiebreak on numeric id so equal timestamps page deterministically.
      if (av === bv) return (Number(a.id) - Number(b.id)) * direction;
      return (av - bv) * direction;
    });
  }

  const total = records.length;
  const startIndex = after ? parseInt(String(after), 10) : 0;
  const page = records.slice(startIndex, startIndex + pageSize);
  const nextIndex = startIndex + pageSize;

  const response: Record<string, unknown> = {
    total,
    results: page.map((r) => {
      // Search responses carry properties only — strip associations.
      const serialized = serializeRecord(r, requestedProperties);
      delete serialized.associations;
      return serialized;
    }),
  };

  if (nextIndex < total) {
    response.paging = { next: { after: String(nextIndex) } };
  }

  res.json(response);
});

// Create record
router.post("/objects/:objectType", (req, res) => {
  const { objectType } = req.params;
  const { properties } = req.body;

  if (!properties) {
    res.status(400).json({
      status: "error",
      message: "Property values were not valid",
      correlationId: "fake-correlation-id",
      category: "VALIDATION_ERROR",
    });
    return;
  }

  const record = store.addRecord(objectType, properties);
  res.status(201).json(serializeRecord(record));
});

// Update record
router.patch("/objects/:objectType/:recordId", (req, res) => {
  const { objectType, recordId } = req.params;
  const { properties } = req.body;

  // Model HubSpot's published-quote lock (DEV-10886): a published quote is locked
  // and rejects any content-property PATCH with "Published Quote cannot be
  // edited." hs_status is HubSpot's always-writable lock control (recall/publish),
  // so a PATCH that touches ONLY hs_status is allowed even while locked; anything
  // else is rejected. This is what forces the connector's recall → edit →
  // re-publish dance.
  if (objectType === "quotes") {
    const current = store.getRecord(objectType, recordId);
    if (
      current &&
      !current.archived &&
      isPublishedQuoteStatus(current.properties.hs_status)
    ) {
      const incoming: Record<string, unknown> = properties ?? {};
      const incomingKeys = Object.keys(incoming);
      const isStatusOnlyChange =
        incomingKeys.length > 0 &&
        incomingKeys.every((key) => key === "hs_status");
      if (!isStatusOnlyChange) {
        res.status(400).json({
          status: "error",
          message:
            `Quote with 'quoteId' of ${recordId} failed update validation. ` +
            `Please correct the errors and then re-submit : Published Quote cannot be edited.`,
          correlationId: "fake-correlation-id",
          category: "VALIDATION_ERROR",
        });
        return;
      }
    }
  }

  const record = store.updateRecord(objectType, recordId, properties ?? {});
  if (!record) {
    res.status(404).json({
      status: "error",
      message: `resource not found`,
      correlationId: "fake-correlation-id",
      category: "OBJECT_NOT_FOUND",
    });
    return;
  }

  res.json(serializeRecord(record));
});

// Delete record
router.delete("/objects/:objectType/:recordId", (req, res) => {
  const { objectType, recordId } = req.params;

  const deleted = store.deleteRecord(objectType, recordId);
  if (!deleted) {
    res.status(404).json({
      status: "error",
      message: `resource not found`,
      correlationId: "fake-correlation-id",
      category: "OBJECT_NOT_FOUND",
    });
    return;
  }

  res.status(204).send();
});

export default router;
