/** Widget types for transformer option fields */
export type TransformerFieldWidget =
  | 'select'
  | 'checkbox'
  | 'text'
  | 'folder_picker'
  | 'json_editor'
  | 'transformer_config';

/** A single option field exposed by a transformer for UI rendering */
export interface TransformerFieldDescriptor {
  /** The key in the options object (e.g. 'targetType') */
  key: string;
  /** Which UI widget to render */
  widget: TransformerFieldWidget;
  /** Human-readable label */
  label: string;
  /** Help text shown below the field */
  description?: string;
  /** Placeholder text for text/select inputs */
  placeholder?: string;
  /** Whether the field must be non-empty for the config to be considered "complete" */
  required?: boolean;
  /** Default value when creating a new config of this type */
  defaultValue?: unknown;

  /** Fixed options for 'select' widget */
  selectOptions?: { value: string; label: string }[];

  /** When true, only show asset folders (for 'folder_picker' widget) */
  assetFoldersOnly?: boolean;

  /** Show this field only when another field matches a value */
  visibleWhen?: { field: string; value: unknown };
}

/** Full metadata for a single transformer type, served by the API */
export interface TransformerMetadata {
  /** The transformer type identifier (e.g. 'auto_convert') */
  type: string;
  /** Human-readable display label */
  label: string;
  /** If true, only visible when dev tools are enabled */
  devOnly?: boolean;
  /** Ordered list of option fields (empty array = no configurable options) */
  fields: TransformerFieldDescriptor[];
  /** Default options object for new configs of this type, computed from field defaults */
  defaultOptions: Record<string, unknown>;
}
