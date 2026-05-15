// A set of options that can be passed to the pullRecordFiles method.
// filter: a connector specific expression that represents the filter to be applied to the records.
// readOnly: when true, the folder is excluded from publish flows regardless of connector capability.
// fullPullOnly: when true, this folder always does full pulls — disables incremental polling regardless of trigger.
// modifiedAtField: name of the connector-side field that records a row's last-modified timestamp.
//   Required for connectors whose incremental support depends on a user-declared field (e.g. an
//   Airtable "Last modified time" column). When unset, those connectors report
//   supportsIncrementalPull() = false and the job demotes incremental runs to full.
// Any other options are unique to connector implementation.
export interface DataFolderOptions {
  filter?: string | undefined;
  readOnly?: boolean | undefined;
  fullPullOnly?: boolean | undefined;
  modifiedAtField?: string | undefined;
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
