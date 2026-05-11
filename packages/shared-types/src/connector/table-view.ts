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
  readonly?: boolean;

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
