export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export type FlagDataType = 'boolean' | 'string' | 'number' | 'array';

export type ExperimentFlagVariantValue = string | number | undefined | JsonValue;
