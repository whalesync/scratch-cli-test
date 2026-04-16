export type ColumnDataType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'unknown';

export interface ColumnAttributes {
  readOnly: boolean;
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
  raw: Record<string, unknown>;
  display: Record<string, string>;
}
