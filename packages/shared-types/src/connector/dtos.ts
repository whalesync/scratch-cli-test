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
  /**
   * `field-select` only: restricts the picker to the folder's schema fields
   * whose JSON Schema `format` is one of these values — e.g. `['date-time']` to
   * offer only timestamp columns for a last-modified-field picker. A nullable
   * column whose `format` lives inside an `anyOf`/`oneOf` union is matched on
   * its non-null member. When omitted, every field is offered. The client
   * applies this generically by reading each field's schema `format`; it needs
   * no connector-specific knowledge.
   */
  fieldSelectFormats?: string[];
  /**
   * Optional whitelist of table `wsId`s this setting applies to. When omitted,
   * the setting applies to every table (backwards-compatible default). When set,
   * the client only renders the setting for folders whose table wsId is listed —
   * e.g. a Contacts-only deep-fetch toggle on a connector with many tables.
   */
  forTableWsIds?: string[];
}

/**
 * A connector setting applies to a table when it declares no `forTableWsIds`
 * whitelist, or the table's wsId is in that whitelist. A scoped setting whose
 * table wsId can't be resolved is hidden (we can't confirm it applies). Shared
 * by the web client and the desktop app so the per-table filter is identical.
 */
export function settingAppliesToTable(setting: ConnectorSettingDefinition, tableWsId: string | undefined): boolean {
  if (!setting.forTableWsIds || setting.forTableWsIds.length === 0) return true;
  if (!tableWsId) return false;
  return setting.forTableWsIds.includes(tableWsId);
}
