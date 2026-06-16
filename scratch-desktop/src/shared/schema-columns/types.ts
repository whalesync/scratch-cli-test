export type ColumnDataType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'unknown';

export interface ColumnAttributes {
  readOnly: boolean;
  // Write-once: editable only while the record is new (not yet published), then
  // read-only. Combine with the record's new-vs-existing state at the edit site:
  // `readOnly || (writeOnce && !recordIsNew)`. See X_SCRATCH_WRITE_ONCE.
  writeOnce: boolean;
  required: boolean;
  connectorDataType?: string;
  remoteFieldId?: string | string[];
  foreignKey?: { linkedTableId: string };
  nested: boolean;
}

export interface ColumnDefinition {
  id: string;
  displayName: string;
  description?: string;
  dataType: ColumnDataType;
  format?: string;
  attributes: ColumnAttributes;
}

export interface NormalizedRecordRow {
  __filename: string;
  __raw: Record<string, unknown>;
}
