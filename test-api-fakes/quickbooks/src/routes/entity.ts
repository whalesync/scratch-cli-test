import { Router } from 'express';
import { store } from '../store';

const router = Router();

const ENTITY_TYPE_MAP: Record<string, string> = {};
const ENTITY_TYPES = [
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

for (const type of ENTITY_TYPES) {
  ENTITY_TYPE_MAP[type.toLowerCase()] = type;
}

// GET /v3/company/:realmId/:entityType/:id
router.get('/v3/company/:realmId/:entityType/:id', (req, res) => {
  const { entityType, id } = req.params;
  const pascalType = ENTITY_TYPE_MAP[entityType.toLowerCase()];

  if (!pascalType) {
    res.status(400).json({
      Fault: {
        type: 'ValidationFault',
        Error: [
          {
            Message: 'Invalid entity type',
            Detail: `Unsupported entity type: ${entityType}`,
            code: '4000',
          },
        ],
      },
    });
    return;
  }

  // CompanyInfo by ID
  if (pascalType === 'CompanyInfo') {
    res.json({
      CompanyInfo: { Id: '1', ...store.companyInfo },
    });
    return;
  }

  const entity = store.getEntity(pascalType, id);
  if (!entity) {
    res.status(404).json({
      Fault: {
        type: 'ValidationFault',
        Error: [
          {
            Message: 'Object Not Found',
            Detail: `${pascalType} with Id ${id} not found`,
            code: '610',
          },
        ],
      },
    });
    return;
  }

  res.json({ [pascalType]: entity });
});

export default router;
