export type EmptyObject = Record<string, never>;

export type JsonSafeValue =
  | string
  | number
  | boolean
  | null
  | {
      [Key in string]?: JsonSafeValue;
    }
  | Array<JsonSafeValue>;

// Make the top level keys strings so we can do things like data['someKey'] = x
export type JsonSafeObject = {
  [Key in string]?: JsonSafeValue;
};

export type ParsedContent = JsonSafeObject;
export type Schema = JsonSafeObject;
