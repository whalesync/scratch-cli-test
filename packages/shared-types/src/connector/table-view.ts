// Type-only import: erased at compile time, so it creates NO runtime edge from
// the package barrel to the transform module. The runtime applier (and its
// jsonpath-rfc9535 dependency) stays behind the `@spinner/shared-types/transform`
// subpath; only the config *type* is referenced here.
import type { DisplayTransformerConfig } from '../transform/apply-display';
// Type-only import: erased at compile time, so it adds NO runtime edge from the barrel to
// sync-mapping's runtime (its zod schemas / helpers). Only the config *type* is referenced.
import type { ClientSafeTransformer } from '../sync-mapping';

/**
 * A UI configuration that describes how to map a JSON record to a set of columns that are visible in a grid.
 * Some information in this is redundant with the Schema. This is deliberate; this should be the source of truth for rendering decisions
 */
export type TableView = {
  // Display name **for the view**.
  name: string;

  // The columns to display, in this order.
  cols: (TableViewCol | TableViewBannerGroup)[];
};

/**
 * Multiple related columns can get grouped together in the UI under a banner.
 * - Street, City, State, Zip can be combined into a "Address" group
 * - All of the fields from a specific WordPress plugin could be put together into a group for that plugin.
 * Only use when the combination is structural and not thematic; don't invent concepts that aren't already meaningful to the user.
 */
export type TableViewBannerGroup = {
  kind: 'banner-group';

  // Title at the top of the group.
  name: string;

  // Columns under the banner. Note: Cannot be more groups, max 1 level of nesting.
  cols: TableViewCol[];

  // Mutable. Hides from the grid, but still available to turn on.
  hidden?: boolean;
};

/**
 * A column in the grid to display the data at a path in the json object.
 * It mostly reflects a single leaf field, but can also provide multiple views of the data inside the field (see `subfields`).
 */
export type TableViewCol = {
  kind: 'col';

  // Title at the top of the column.
  name?: string; // Or use sane default.

  // The JSON path in the record to the root of this field.
  path: string;

  // Hint to the renderer on how to format.
  type?: TablePropertyType;

  // The column's SEMANTIC type for sync / Live Export purposes, when it differs
  // from the render `type` above. `type` is a rendering hint (which grid cell to
  // draw); `logicalType` is what the value actually IS once flattened — the type
  // a sync's transform picker and the create-schema plan generator should treat
  // it as when copying it to another service.
  //
  // The two diverge when a column carries a `displayTransformer` that flattens a
  // structured raw value to a scalar: the grid must render such a column through
  // the text cell (`type:'string'`) because only that cell consults the
  // `displayTransformer` — but the flattened value is really a number / date /
  // boolean / url, and the export layer must see THAT so the destination field is
  // created with the right type and the value isn't packed as text (e.g. an Attio
  // currency/number attribute whose grid cell is text but whose exported value is
  // a number). When unset, the export layer falls back to `type`.
  logicalType?: TablePropertyType;
  readonly?: boolean;

  // Write-once: editable while the record is brand-new (not yet published) but
  // read-only once it exists remotely. The renderer combines this with the row's
  // new-vs-existing state: `readonly || (writeOnce && !recordIsNew)`. See
  // X_SCRATCH_WRITE_ONCE in json-schema.ts.
  writeOnce?: boolean;

  // Optional declarative instruction for deriving this column's DISPLAY string
  // from its raw value (e.g. flatten a Notion rich-text array to plain_text).
  // The renderer runs it through the generic, fail-closed applier in
  // `@spinner/shared-types/transform` and falls back to the raw value if it
  // returns `{ok:false}`. Display-only: never applied to the edit/copy/persisted
  // value. The connector (server) sets this; the renderer stays connector-agnostic.
  displayTransformer?: DisplayTransformerConfig;

  // Bidirectional codec (toCore/fromCore) for collapsing this column to/from the neutral CORE
  // value shared by the grid and a sync — the editorial layer's account of how the field's inner
  // values become the single value shown/edited/copied. See ColumnCodec. Set by the connector
  // (server); the sync's transform picker resolves it View-first, deriving from
  // `displayTransformer` and the schema hints when a half is absent.
  codec?: ColumnCodec;

  // When this column's values link to another table, the foreign-key target. Set by
  // the connector (server); mirrors the schema's `x-scratch-foreign-key`. Required for
  // SYNTHESIZED link columns whose FK annotation sits BELOW the column's own path and
  // so can't be recovered by joining the column path back to the schema — e.g.
  // HubSpot's "Associated X" columns, flattened from `associations.<type>.results[].id`.
  // (Per this type's contract above, the view deliberately carries schema-redundant
  // hints and is the source of truth for rendering decisions.)
  //
  // `isSingleValued` mirrors the schema annotation's field of the same name: true when
  // the column links to at most ONE record (Linear's `team`/`assignee`), false/unset when
  // it can link to many (HubSpot associations, Linear's `labelIds`). A relation left
  // unset is treated as multi-valued, which makes a destination that stores a foreign key
  // in a single scalar column (Postgres/Supabase) report the field as narrowed — so a
  // genuinely single-valued link should say so.
  foreignKey?: { linkedTableId: string; isSingleValued?: boolean };

  // When the field is an object, we may want to define a few subfields for the user to pick between, for
  // ergonomics. To the user, a complex object might only have one interesting field, which accurately represents it. For example,
  // Shopify's 'Blog count' field looks like: `{count, precision}`, but the user wants to see it as a number (count).
  //
  // If `subfields` is unset, the column only renders the root, using `type` above.
  // However, if this is set, these options are presented to the user **in addition** to the root ("Raw" / "All")
  // `selectedSubfield` will usually have one of them preselected.
  // In this case, the user will always see a default built-in option of "All" to show the root of this Column.
  subfields?: TableViewSubfield[];

  // Mutable. Hides from the grid, but still available to turn on.
  hidden?: boolean;
  selectedSubfield?: number; // Shows the root field if unset.
};

export type TableViewSubfield = {
  // Title for the subfield. Will be displayed in the context of the Column's title, so does not need to repeat that.
  name?: string; // Or use sane default.

  // JSON path to display relative to the Column's `path`.
  relativePath: string;

  // Hint to the renderer on how to format.
  type?: TablePropertyType;
  readonly?: boolean;

  // Write-once: editable only while the record is new. See TableViewCol.writeOnce.
  writeOnce?: boolean;

  // Bidirectional codec for this subfield leaf, used when the subfield becomes a sync mapping's
  // column (a selected subfield's effective path `col.path + '.' + relativePath` IS the mapping
  // columnId). Mirrors TableViewCol.codec, so a selected subfield owns its codec directly.
  codec?: ColumnCodec;
};

/**
 * Bidirectional codec for collapsing a column (or subfield) to/from the connector-neutral CORE
 * value (`CoreValue` in `transform-picker.ts`) used by BOTH the grid and a sync. It lives on the
 * View — the editorial layer — so the same declaration powers the grid cell and the sync copy:
 *
 *   toCore   : native value → CoreValue   (extract; the grid's display source, a sync's SOURCE half)
 *   fromCore : CoreValue → native value   (pack;    the grid's edit-save,     a sync's DESTINATION half)
 *
 * Both halves are optional. When a half is absent the resolver falls back, in order: derive from
 * `displayTransformer` (toCore only; array-handling set by the column's cardinality) → the schema's
 * suggested / suggestedIn hint on the nearest ancestor field → a smart typed default. Transformers
 * are restricted to `ClientSafeTransformer` (no server-only FK/asset/lookup arms) because the View
 * is serialized to the frontends.
 */
export type ColumnCodec = {
  // native → CoreValue (extract). If omitted: derive from displayTransformer → schema hint → smart default.
  toCore?: ClientSafeTransformer;
  // CoreValue → native (pack). If omitted: schema suggestedInTransformer on the nearest ancestor → smart default.
  fromCore?: ClientSafeTransformer;

  // Future expansion — surfaced to the user as pickable options / config knobs, mirroring the sync
  // suggestion service's TransformOption. Reserved so it slots in with zero restructure:
  // options?: OptionKnob[];
  // variants?: [CodecVariant, ...CodecVariant[]];
};

export type TablePropertyType =
  | 'string'
  | 'richtext'
  | 'number'
  | 'date'
  | 'url'
  | 'checkbox'
  | 'object'
  | (string & {});
