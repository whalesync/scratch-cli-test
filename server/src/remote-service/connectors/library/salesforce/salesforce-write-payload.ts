import { X_SCRATCH_READONLY, X_SCRATCH_WRITE_ONCE } from '@spinner/shared-types';
import { NonWritableFieldEditError, NonWritableFieldReason, nonWritableFieldEditErrorMessage } from '../../error';
import { BaseJsonTableSpec, ConnectorFile } from '../../types';
import {
  SALESFORCE_RECORD_ATTRIBUTES_KEY,
  SALESFORCE_RECORD_ID_FIELD,
  salesforceSchemaPropertyAnnotations,
} from './salesforce-json-schema';

function isReadonlyInSchema(tableSpec: BaseJsonTableSpec, fieldApiName: string): boolean {
  return salesforceSchemaPropertyAnnotations(tableSpec, fieldApiName)?.[X_SCRATCH_READONLY] === true;
}

function isWriteOnceInSchema(tableSpec: BaseJsonTableSpec, fieldApiName: string): boolean {
  return salesforceSchemaPropertyAnnotations(tableSpec, fieldApiName)?.[X_SCRATCH_WRITE_ONCE] === true;
}

/** The object API name a table's records belong to — the `type` every sObject Collections record must carry. */
export function salesforceObjectApiNameOfTable(tableSpec: BaseJsonTableSpec): string {
  return tableSpec.id.remoteId[0];
}

/**
 * The sObject Collections create body for one record file: `attributes.type` plus the file's fields.
 *
 * The file's fields are sent as the user wrote them, so Salesforce validates them and names any it rejects.
 * Three things are left out because they carry nothing to create:
 *  - `attributes`, Salesforce's own record metadata (replaced by `{ type }`);
 *  - an empty `Id` (a new record has none yet);
 *  - a read-only field set to `null`, such as `CreatedDate: null` in a record an agent filled out from the
 *    schema. Salesforce rejects any read-only field in a create, even a null one, and a null holds no value to
 *    lose. A read-only field with a value is still sent, and Salesforce rejects it by name.
 */
export function buildSalesforceCreateRecordBody(file: ConnectorFile, tableSpec: BaseJsonTableSpec): ConnectorFile {
  const createBody: ConnectorFile = {
    [SALESFORCE_RECORD_ATTRIBUTES_KEY]: { type: salesforceObjectApiNameOfTable(tableSpec) },
  };
  for (const [fieldApiName, value] of Object.entries(file)) {
    if (fieldApiName === SALESFORCE_RECORD_ATTRIBUTES_KEY) continue;
    if (fieldApiName === SALESFORCE_RECORD_ID_FIELD && (value === null || value === undefined || value === '')) {
      continue;
    }
    if (value === null && isReadonlyInSchema(tableSpec, fieldApiName)) continue;
    createBody[fieldApiName] = value;
  }
  return createBody;
}

/**
 * The sObject Collections update body for one record from the fields the user changed: `attributes.type`, `id`,
 * and the changed fields.
 *
 * Throws {@link NonWritableFieldEditError} when a changed field can't be written — a read-only field (system,
 * formula, roll-up, compound address), a set-on-create-only field, or the record's own `attributes`/`Id` — so
 * the edit is reported rather than silently dropped.
 */
export function buildSalesforceUpdateRecordBodyFromChangedFields(
  recordId: string,
  changedFields: Record<string, unknown>,
  tableSpec: BaseJsonTableSpec,
): ConnectorFile {
  const updateBody: ConnectorFile = {
    [SALESFORCE_RECORD_ATTRIBUTES_KEY]: { type: salesforceObjectApiNameOfTable(tableSpec) },
    id: recordId,
  };
  const readOnlyChangedFieldApiNames: string[] = [];
  const setOnCreateOnlyChangedFieldApiNames: string[] = [];
  for (const [fieldApiName, value] of Object.entries(changedFields)) {
    if (
      fieldApiName === SALESFORCE_RECORD_ATTRIBUTES_KEY ||
      fieldApiName === SALESFORCE_RECORD_ID_FIELD ||
      isReadonlyInSchema(tableSpec, fieldApiName)
    ) {
      readOnlyChangedFieldApiNames.push(fieldApiName);
      continue;
    }
    if (isWriteOnceInSchema(tableSpec, fieldApiName)) {
      setOnCreateOnlyChangedFieldApiNames.push(fieldApiName);
      continue;
    }
    updateBody[fieldApiName] = value;
  }
  if (readOnlyChangedFieldApiNames.length > 0 || setOnCreateOnlyChangedFieldApiNames.length > 0) {
    throw new NonWritableFieldEditError(
      nonWritableFieldEditErrorMessage({
        [NonWritableFieldReason.ReadOnly]: readOnlyChangedFieldApiNames,
        [NonWritableFieldReason.SetOnCreateOnly]: setOnCreateOnlyChangedFieldApiNames,
      }),
    );
  }
  return updateBody;
}

/**
 * The update body for a publish path that has no field-level diff: every field of the record that can be
 * updated. The record necessarily carries its read-only and set-on-create-only fields (they were pulled with it),
 * and with no diff there's no telling whether the user touched them, so they are left out rather than failing a
 * record whose edit may have been anywhere else.
 */
export function buildSalesforceUpdateRecordBodyFromFullRecord(
  recordId: string,
  file: ConnectorFile,
  tableSpec: BaseJsonTableSpec,
): ConnectorFile {
  const updateBody: ConnectorFile = {
    [SALESFORCE_RECORD_ATTRIBUTES_KEY]: { type: salesforceObjectApiNameOfTable(tableSpec) },
    id: recordId,
  };
  for (const [fieldApiName, value] of Object.entries(file)) {
    if (fieldApiName === SALESFORCE_RECORD_ATTRIBUTES_KEY || fieldApiName === SALESFORCE_RECORD_ID_FIELD) continue;
    if (isReadonlyInSchema(tableSpec, fieldApiName) || isWriteOnceInSchema(tableSpec, fieldApiName)) continue;
    updateBody[fieldApiName] = value;
  }
  return updateBody;
}
