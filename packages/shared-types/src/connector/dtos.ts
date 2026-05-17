// A set of options that can be passed to the pullRecordFiles method.
// filter: a connector specific expression that represents the filter to be applied to the records.
// readOnly: when true, the folder is excluded from publish flows regardless of connector capability.
// modifiedAtField: name of the connector-side field that records a row's last-modified timestamp.
//   Required for connectors whose incremental support depends on a user-declared field (e.g. an
//   Airtable "Last modified time" column). When unset, those connectors report
//   supportsIncrementalPull() = false and the job demotes incremental runs to full.
// Any other options are unique to connector implementation.
export interface DataFolderOptions {
  filter?: string | undefined;
  readOnly?: boolean | undefined;
  modifiedAtField?: string | undefined;
  [key: string]: unknown;
}

/** Describes a single advanced setting that a connector exposes. */
export interface ConnectorSettingDefinition {
  key: string;
  /**
   * `field-select`: rendered by the client as a searchable picker of the
   * folder's schema field names (with a free-text fallback for untyped
   * columns). Persisted/validated identically to `string`.
   */
  type: 'boolean' | 'number' | 'string' | 'password' | 'field-select';
  label: string;
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  required?: boolean;
}
