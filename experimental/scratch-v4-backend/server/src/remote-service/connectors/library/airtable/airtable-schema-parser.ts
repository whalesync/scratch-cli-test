import { sanitizeForTableWsId } from '../../ids';
import { TablePreview } from '../../types';
import { AirtableBase, AirtableTableV2 } from './airtable-types';

export class AirtableSchemaParser {
  parseTablePreview(base: AirtableBase, table: AirtableTableV2): TablePreview {
    return {
      id: {
        wsId: sanitizeForTableWsId(table.name),
        remoteId: [base.id, table.id],
      },
      displayName: table.name,
      metadata: {
        baseName: base.name,
      },
    };
  }
}
