import { Router } from 'express';
import { store } from '../store';

const router = Router();

const SUPPORTED_ENTITY_TYPES = [
  'Account',
  'Bill',
  'BillPayment',
  'CompanyInfo',
  'CreditMemo',
  'Customer',
  'Deposit',
  'Employee',
  'Estimate',
  'Invoice',
  'Item',
  'JournalEntry',
  'Payment',
  'PaymentMethod',
  'Purchase',
  'PurchaseOrder',
  'RefundReceipt',
  'SalesReceipt',
  'TaxCode',
  'TaxRate',
  'Term',
  'TimeActivity',
  'Vendor',
];

interface ParsedQuery {
  fields: string[] | '*';
  entityType: string;
  startPosition?: number;
  maxResults?: number;
}

function parseQuery(sql: string): ParsedQuery | null {
  const normalized = sql.trim().replace(/\s+/g, ' ');

  // Match: SELECT <fields> FROM <EntityType> [STARTPOSITION <n>] [MAXRESULTS <n>]
  const match = normalized.match(
    /^SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+STARTPOSITION\s+(\d+))?(?:\s+MAXRESULTS\s+(\d+))?$/i,
  );
  if (!match) return null;

  const rawFields = match[1].trim();
  const fields: string[] | '*' = rawFields === '*' ? '*' : rawFields.split(/\s*,\s*/);
  const entityType = match[2];
  const startPosition = match[3] ? parseInt(match[3], 10) : undefined;
  const maxResults = match[4] ? parseInt(match[4], 10) : undefined;

  return { fields, entityType, startPosition, maxResults };
}

function toPascalCase(entityType: string): string | undefined {
  const lower = entityType.toLowerCase();
  return SUPPORTED_ENTITY_TYPES.find((t) => t.toLowerCase() === lower);
}

// GET /v3/company/:realmId/query?query=<SQL-like query>
router.get('/v3/company/:realmId/query', (req, res) => {
  const queryString = req.query.query;
  if (typeof queryString !== 'string' || !queryString.trim()) {
    res.status(400).json({
      Fault: {
        type: 'ValidationFault',
        Error: [
          {
            Message: 'Invalid query',
            Detail: 'Missing or empty query parameter',
            code: '4000',
          },
        ],
      },
    });
    return;
  }

  const parsed = parseQuery(queryString);
  if (!parsed) {
    res.status(400).json({
      Fault: {
        type: 'ValidationFault',
        Error: [
          {
            Message: 'Invalid query',
            Detail: `Could not parse query: ${queryString}`,
            code: '4000',
          },
        ],
      },
    });
    return;
  }

  const pascalType = toPascalCase(parsed.entityType);
  if (!pascalType) {
    res.status(400).json({
      Fault: {
        type: 'ValidationFault',
        Error: [
          {
            Message: 'Invalid query',
            Detail: `Unsupported entity type: ${parsed.entityType}`,
            code: '4000',
          },
        ],
      },
    });
    return;
  }

  // CompanyInfo is special — always return from store.companyInfo
  if (pascalType === 'CompanyInfo') {
    const companyInfoEntity = { Id: '1', ...store.companyInfo };
    let result: Record<string, unknown> = companyInfoEntity;

    // If specific fields were requested, filter to just those fields
    if (parsed.fields !== '*') {
      result = { Id: '1' };
      for (const field of parsed.fields) {
        if (field in companyInfoEntity) {
          result[field] = (companyInfoEntity as Record<string, unknown>)[field];
        }
      }
    }

    res.json({
      QueryResponse: {
        CompanyInfo: [result],
        maxResults: 1,
        totalCount: 1,
      },
    });
    return;
  }

  const allEntities = store.listEntities(pascalType);
  const totalCount = allEntities.length;
  const startPosition = parsed.startPosition ?? 1;
  const maxResults = parsed.maxResults ?? 1000;

  // STARTPOSITION is 1-based
  const startIndex = startPosition - 1;
  const page = allEntities.slice(startIndex, startIndex + maxResults);

  const response: Record<string, unknown> = {
    [pascalType]: page,
    startPosition,
    maxResults: page.length,
    totalCount,
  };

  res.json({ QueryResponse: response });
});

export default router;
