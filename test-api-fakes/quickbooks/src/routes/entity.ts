import { Router } from "express";
import { store, Store } from "../store";

const router = Router();

function validationFault(message: string, detail: string, code = "4000") {
  return {
    Fault: {
      type: "ValidationFault",
      Error: [{ Message: message, Detail: detail, code }],
    },
  };
}

const ENTITY_TYPE_MAP: Record<string, string> = {};
const ENTITY_TYPES = [
  "Account",
  "Bill",
  "BillPayment",
  "CompanyInfo",
  "CreditMemo",
  "Customer",
  "Deposit",
  "Employee",
  "Estimate",
  "Invoice",
  "Item",
  "JournalEntry",
  "Payment",
  "PaymentMethod",
  "Purchase",
  "PurchaseOrder",
  "RefundReceipt",
  "SalesReceipt",
  "TaxCode",
  "TaxRate",
  "Term",
  "TimeActivity",
  "Vendor",
];

for (const type of ENTITY_TYPES) {
  ENTITY_TYPE_MAP[type.toLowerCase()] = type;
}

// GET /v3/company/:realmId/:entityType/:id
router.get("/v3/company/:realmId/:entityType/:id", (req, res) => {
  const { entityType, id } = req.params;
  const pascalType = ENTITY_TYPE_MAP[entityType.toLowerCase()];

  if (!pascalType) {
    res.status(400).json({
      Fault: {
        type: "ValidationFault",
        Error: [
          {
            Message: "Invalid entity type",
            Detail: `Unsupported entity type: ${entityType}`,
            code: "4000",
          },
        ],
      },
    });
    return;
  }

  // CompanyInfo by ID
  if (pascalType === "CompanyInfo") {
    res.json({
      CompanyInfo: { Id: "1", ...store.companyInfo },
    });
    return;
  }

  const entity = store.getEntity(pascalType, id);
  if (!entity) {
    res.status(404).json({
      Fault: {
        type: "ValidationFault",
        Error: [
          {
            Message: "Object Not Found",
            Detail: `${pascalType} with Id ${id} not found`,
            code: "610",
          },
        ],
      },
    });
    return;
  }

  res.json({ [pascalType]: entity });
});

// POST /v3/company/:realmId/:entityType
// QBO uses one collection endpoint for create, sparse update, and delete:
//   - no Id in body           → create
//   - Id + SyncToken in body  → sparse/full update
//   - ?operation=delete       → hard delete (transactions)
router.post("/v3/company/:realmId/:entityType", (req, res) => {
  const { entityType } = req.params;
  const pascalType = ENTITY_TYPE_MAP[entityType.toLowerCase()];

  if (!pascalType) {
    res.status(400).json(validationFault("Invalid entity type", `Unsupported entity type: ${entityType}`));
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const operation = typeof req.query.operation === "string" ? req.query.operation.toLowerCase() : undefined;

  // ── CompanyInfo: update-only singleton ──
  if (pascalType === "CompanyInfo") {
    store.companyInfo = { ...store.companyInfo, ...body };
    res.json({ CompanyInfo: { Id: "1", ...store.companyInfo } });
    return;
  }

  // ── Delete (transactions) ──
  if (operation === "delete") {
    const id = String(body.Id ?? "");
    const existing = id ? store.getEntity(pascalType, id) : undefined;
    if (!existing) {
      res.status(404).json(validationFault("Object Not Found", `${pascalType} with Id ${id} not found`, "610"));
      return;
    }
    if (isStale(existing, body)) {
      res.status(400).json(staleFault(pascalType));
      return;
    }
    store.deleteEntity(pascalType, id);
    res.json({ [pascalType]: { Id: id, status: "Deleted", domain: "QBO" } });
    return;
  }

  // ── Update (Id present) ──
  if (body.Id !== undefined && body.Id !== null && String(body.Id) !== "") {
    const id = String(body.Id);
    const existing = store.getEntity(pascalType, id);
    if (!existing) {
      res.status(404).json(validationFault("Object Not Found", `${pascalType} with Id ${id} not found`, "610"));
      return;
    }
    if (isStale(existing, body)) {
      res.status(400).json(staleFault(pascalType));
      return;
    }

    const { Id: _id, SyncToken: _token, sparse, ...fields } = body;
    // sparse: merge the supplied fields onto the existing record. Non-sparse:
    // replace (QBO nulls omitted fields — we keep Id/domain but drop the rest).
    const merged: Record<string, unknown> =
      sparse === true ? { ...existing, ...fields } : { Id: id, domain: existing.domain, ...fields };
    merged.Id = id;
    merged.SyncToken = Store.nextSyncToken(existing.SyncToken);
    store.putEntity(pascalType, merged as typeof existing);
    res.json({ [pascalType]: merged });
    return;
  }

  // ── Create (no Id) ──
  const created = store.addEntity(pascalType, { ...body, Id: store.generateId(), SyncToken: "0" });
  res.status(200).json({ [pascalType]: created });
});

/** A stored record is stale if the write's SyncToken doesn't match the current one. */
function isStale(existing: Record<string, unknown>, body: Record<string, unknown>): boolean {
  return String(body.SyncToken ?? "") !== String(existing.SyncToken ?? "");
}

function staleFault(pascalType: string) {
  return {
    Fault: {
      type: "ValidationFault",
      Error: [
        {
          Message: "Stale Object Error",
          Detail: `Stale Object Error : You and ${pascalType} was updated by another user at the same time.`,
          code: "5010",
        },
      ],
    },
  };
}

export default router;
