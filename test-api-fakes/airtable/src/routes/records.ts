import { Router } from "express";
import { store } from "../store";

const router = Router();

const PAGE_SIZE = 100;

function parseRecordIdsFromFormula(formula: string): string[] | null {
  // Handle OR(RECORD_ID()='id1',RECORD_ID()='id2') pattern
  const orMatch = formula.match(/^OR\((.+)\)$/);
  const inner = orMatch ? orMatch[1] : formula;

  const ids: string[] = [];
  const regex = /RECORD_ID\(\)\s*=\s*'([^']+)'/g;
  let match;
  while ((match = regex.exec(inner)) !== null) {
    ids.push(match[1]);
  }

  return ids.length > 0 ? ids : null;
}

router.get("/:baseId/:tableId", (req, res) => {
  const { baseId, tableId } = req.params;
  const { offset, filterByFormula } = req.query;

  const tables = store.listTables(baseId);
  if (tables === undefined || !tables.some((t) => t.id === tableId)) {
    res.status(404).json({
      error: {
        type: "NOT_FOUND",
        message: "Could not find table",
      },
    });
    return;
  }

  let records = store.listRecords(baseId, tableId);

  // Apply filterByFormula if present
  if (filterByFormula && typeof filterByFormula === "string") {
    const filteredIds = parseRecordIdsFromFormula(filterByFormula);
    if (filteredIds) {
      const idSet = new Set(filteredIds);
      records = records.filter((r) => idSet.has(r.id));
    }
  }

  // Apply pagination
  const startIndex = offset
    ? parseInt(Buffer.from(offset as string, "base64").toString("utf-8"), 10)
    : 0;
  const page = records.slice(startIndex, startIndex + PAGE_SIZE);

  const response: { records: typeof page; offset?: string } = {
    records: page.map((r) => ({
      id: r.id,
      fields: r.fields,
      createdTime: r.createdTime,
    })),
  };

  if (startIndex + PAGE_SIZE < records.length) {
    response.offset = Buffer.from(String(startIndex + PAGE_SIZE)).toString(
      "base64",
    );
  }

  res.json(response);
});

router.post("/:baseId/:tableId", (req, res) => {
  const { baseId, tableId } = req.params;
  const { records: inputRecords } = req.body;

  if (!inputRecords || inputRecords.length > 10) {
    res.status(422).json({
      error: {
        type: "INVALID_REQUEST",
        message: "Cannot create more than 10 records at a time",
      },
    });
    return;
  }

  const tables = store.listTables(baseId);
  if (tables === undefined || !tables.some((t) => t.id === tableId)) {
    res.status(404).json({
      error: {
        type: "NOT_FOUND",
        message: "Could not find table",
      },
    });
    return;
  }

  const created = inputRecords.map(
    (input: { fields: Record<string, unknown> }) => {
      const record = store.addRecord(baseId, tableId, input.fields);
      return {
        id: record.id,
        fields: record.fields,
        createdTime: record.createdTime,
      };
    },
  );

  res.json({ records: created });
});

router.patch("/:baseId/:tableId", (req, res) => {
  const { baseId, tableId } = req.params;
  const { records: inputRecords } = req.body;

  if (!inputRecords || inputRecords.length > 10) {
    res.status(422).json({
      error: {
        type: "INVALID_REQUEST",
        message: "Cannot update more than 10 records at a time",
      },
    });
    return;
  }

  const updated = [];
  for (const input of inputRecords) {
    const record = store.updateRecord(baseId, tableId, input.id, input.fields);
    if (!record) {
      res.status(404).json({
        error: {
          type: "NOT_FOUND",
          message: "Could not find record",
        },
      });
      return;
    }
    updated.push({
      id: record.id,
      fields: record.fields,
      createdTime: record.createdTime,
    });
  }

  res.json({ records: updated });
});

router.delete("/:baseId/:tableId", (req, res) => {
  const { baseId, tableId } = req.params;

  // Support both records[] and records query params
  let recordIds: string[] = [];
  if (req.query["records[]"]) {
    const param = req.query["records[]"];
    recordIds = Array.isArray(param) ? (param as string[]) : [param as string];
  } else if (req.query["records"]) {
    const param = req.query["records"];
    recordIds = Array.isArray(param) ? (param as string[]) : [param as string];
  }

  // Delete each record (idempotent — return deleted: true even if not found)
  const results = recordIds.map((id) => {
    store.deleteRecord(baseId, tableId, id);
    return { id, deleted: true };
  });

  res.json({ records: results });
});

export default router;
