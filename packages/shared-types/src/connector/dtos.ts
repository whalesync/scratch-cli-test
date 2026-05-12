// A set of options that can be passed to the pullRecordFiles method.
// filter: a connector specific expression that represents the filter to be applied to the records.
// readOnly: when true, the folder is excluded from publish flows regardless of connector capability.
// Any other options are unique to connector implementation.
export interface DataFolderOptions {
  filter?: string | undefined;
  readOnly?: boolean | undefined;
  [key: string]: unknown;
}

/** Describes a single advanced setting that a connector exposes. */
export interface ConnectorSettingDefinition {
  key: string;
  type: 'boolean' | 'number' | 'string' | 'password';
  label: string;
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  required?: boolean;
}
