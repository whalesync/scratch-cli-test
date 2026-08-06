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
   *
   * `string-list`: rendered by the client as repeatable text rows with
   * add/remove controls (e.g. Google Sheets' spreadsheet URLs on the connect
   * form). `required` means "at least one non-empty row"; each non-empty row
   * is validated against `itemPattern` when set. On submit the rows are
   * newline-joined into ONE string wherever the wire contract expects a string
   * value (OAuth initiate options, userProvidedParams), so consumers parse it
   * exactly like a `string` field.
   */
  type: 'boolean' | 'number' | 'string' | 'password' | 'field-select' | 'string-list';
  label: string;
  description?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  required?: boolean;
  /**
   * `string-list` only: JS regex source each non-empty row must match (a cheap
   * client-side shape check — the server stays lenient and re-parses on its
   * own terms). Evaluated as `new RegExp(itemPattern)`, no flags.
   */
  itemPattern?: string;
  /** `string-list` only: per-row error message shown when `itemPattern` fails. */
  itemPatternDescription?: string;
  /**
   * `string-list` only: the `ConnectorAccount.extras` key under which this
   * field's rows persist VERBATIM as a `string[]` (the server derives whatever
   * it needs from them at read time). Declaring it makes the field editable
   * after connect: the edit-connection modal prefills the rows from
   * `extras[extrasKey]` and writes them back on save — all generically, with no
   * connector knowledge in the frontend. Omit for connect-form-only fields.
   */
  extrasKey?: string;
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
  /**
   * Optional list of table-`wsId` PREFIXES this setting applies to — the
   * dynamic-table counterpart of `forTableWsIds` (exact match can't target tables
   * whose wsIds aren't known statically). A setting applies when the table's wsId
   * is in `forTableWsIds` OR starts with any entry here. Use it to scope a setting
   * to a CLASS of per-parent tables: e.g. YouTube mints one Videos table per channel
   * as `videos_<channelId>`, so `forTableWsIdPrefixes: ['videos_']` targets every
   * channel's Videos table while leaving Playlists/Channel/etc. unaffected. Omitting
   * both fields = applies to all tables.
   */
  forTableWsIdPrefixes?: string[];
}

/**
 * A connector setting applies to a table when it declares no scoping at all
 * (`forTableWsIds` and `forTableWsIdPrefixes` both empty/absent), OR the table's
 * wsId is in `forTableWsIds`, OR the table's wsId starts with one of
 * `forTableWsIdPrefixes` (the dynamic per-parent case, e.g. `videos_<channelId>`).
 * A scoped setting whose table wsId can't be resolved is hidden (we can't confirm
 * it applies). Shared by the web client and the desktop app so the per-table filter
 * is identical.
 */
export function settingAppliesToTable(setting: ConnectorSettingDefinition, tableWsId: string | undefined): boolean {
  const exactWsIds = setting.forTableWsIds ?? [];
  const wsIdPrefixes = setting.forTableWsIdPrefixes ?? [];
  // No scoping declared → applies to every table (backwards-compatible default).
  if (exactWsIds.length === 0 && wsIdPrefixes.length === 0) return true;
  if (!tableWsId) return false;
  if (exactWsIds.includes(tableWsId)) return true;
  return wsIdPrefixes.some((prefix) => tableWsId.startsWith(prefix));
}
