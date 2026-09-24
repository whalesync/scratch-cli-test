import { assertUnreachable } from '@/utils/helpers';
import {
  type CreateFieldKind,
  type CreateFieldSpec,
  type CreateFieldType,
  type CreateSchemaFieldsDto,
  type CreateSchemaTablesDto,
  type CreateTableSpec,
  type NativeFieldType,
  type ValidateSchemaIssue,
} from '@spinner/shared-types';

/**
 * Editor-only state + mapping helpers for the schema-creation dev tool.
 *
 * These `Editor*` types are NOT wire types — they hold the in-progress form
 * state (a flat bag of every kind-specific input so the user can switch a
 * field's data type without losing what they typed). On submit they are mapped
 * to the real `@spinner/shared-types` request DTOs by the `to*` functions below.
 * The wire types are the single source of truth; nothing here is shared.
 */

export type NumberFieldFormat = 'plain' | 'integer' | 'decimal' | 'percent';
export type ForeignKeyTargetMode = 'existing' | 'ref';

/** Human labels for the data-type `Select`. */
export const FIELD_KIND_LABELS: Record<CreateFieldKind, string> = {
  text: 'Text',
  longText: 'Long text',
  number: 'Number',
  boolean: 'Boolean',
  date: 'Date',
  select: 'Select',
  multiSelect: 'Multi-select',
  url: 'URL',
  email: 'Email',
  phone: 'Phone',
  currency: 'Currency',
  foreignKey: 'Foreign key',
  json: 'JSON',
};

/** Kinds whose fields can hold a LIST of values (`fieldType.isArray`, e.g. a Postgres `text[]`). */
export const LIST_CAPABLE_FIELD_KINDS: ReadonlySet<CreateFieldKind> = new Set(['text', 'number', 'boolean']);

export const NUMBER_FORMATS: NumberFieldFormat[] = ['plain', 'integer', 'decimal', 'percent'];

export interface EditorChoiceOption {
  id: string;
  name: string;
  color: string;
}

export interface EditorField {
  id: string;
  name: string;
  kind: CreateFieldKind;
  isPrimary: boolean;
  required: boolean;
  /**
   * True for the auto-injected field that holds the source record's remote id.
   * The editor renders it as mandatory: its name and data type are locked and it
   * cannot be removed. Round-trips to the wire `CreateFieldSpec.isSourceRecordId`.
   */
  isSourceRecordId: boolean;
  description: string;
  /**
   * The source's exact native column type a generated plan carried (`CreateFieldSpec.nativeFieldType`),
   * with the logical field type it was generated alongside. Re-emitted only while the field's logical type
   * is still exactly that one: the native type describes the ORIGINAL column, so ANY edit to the data type —
   * the kind, "List of values", a number's format or precision — drops it and the edited logical type is
   * created instead.
   */
  nativeFieldTypeFromPlan: { nativeFieldType: NativeFieldType; generatedWithFieldType: CreateFieldType } | null;
  // text / number / boolean: a list of values rather than a single value
  isArray: boolean;
  // number / currency precision (text input, parsed on submit)
  precision: string;
  // number
  format: NumberFieldFormat;
  // date
  includesTime: boolean;
  // select / multiSelect
  options: EditorChoiceOption[];
  // currency
  currencyCode: string;
  // foreignKey
  foreignKeyTargetMode: ForeignKeyTargetMode;
  foreignKeyExistingRemoteTableId: string;
  foreignKeyRef: string;
  foreignKeyAllowMultiple: boolean;
}

export interface EditorTable {
  id: string;
  name: string;
  ref: string;
  fields: EditorField[];
}

// A simple monotonic counter is enough for stable React keys + unique table
// refs within one editor session (these ids never leave the browser).
let editorIdCounter = 0;
function nextEditorId(prefix: string): string {
  editorIdCounter += 1;
  return `${prefix}_${editorIdCounter}`;
}

export function makeEmptyChoiceOption(): EditorChoiceOption {
  return { id: nextEditorId('opt'), name: '', color: '' };
}

export function makeEmptyField(): EditorField {
  return {
    id: nextEditorId('field'),
    name: '',
    kind: 'text',
    isPrimary: false,
    required: false,
    isSourceRecordId: false,
    description: '',
    nativeFieldTypeFromPlan: null,
    isArray: false,
    precision: '',
    format: 'plain',
    includesTime: false,
    options: [makeEmptyChoiceOption()],
    currencyCode: 'USD',
    foreignKeyTargetMode: 'existing',
    foreignKeyExistingRemoteTableId: '',
    foreignKeyRef: '',
    foreignKeyAllowMultiple: false,
  };
}

export function makeEmptyTable(): EditorTable {
  const id = nextEditorId('table');
  // The id doubles as the default `ref` — guaranteed unique within the request
  // and editable by the user.
  return { id, name: '', ref: id, fields: [makeEmptyField()] };
}

/**
 * Remote ids are `string[]` on the wire (connector-interpreted path segments —
 * e.g. Postgres `schema/table`, Airtable `base/table`). The editor uses a single
 * text input and splits on `/`.
 */
export function splitRemoteId(value: string): string[] {
  return value
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Ids of fields whose (trimmed, case-insensitive) name collides with another
 * field in the same list. Mirrors the server's DUPLICATE_FIELD_NAME rule so the
 * form can flag duplicates inline before validate/create. Empty names are ignored.
 */
export function findDuplicateFieldNameIds(fields: { id: string; name: string }[]): Set<string> {
  const nameCounts = new Map<string, number>();
  for (const field of fields) {
    const key = field.name.trim().toLowerCase();
    if (!key) continue;
    nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
  }
  const duplicateFieldIds = new Set<string>();
  for (const field of fields) {
    const key = field.name.trim().toLowerCase();
    if (key && (nameCounts.get(key) ?? 0) > 1) {
      duplicateFieldIds.add(field.id);
    }
  }
  return duplicateFieldIds;
}

export function toCreateFieldType(field: EditorField): CreateFieldType {
  switch (field.kind) {
    case 'text':
    case 'boolean':
      return { kind: field.kind, ...(field.isArray ? { isArray: true } : {}) };
    case 'longText':
    case 'url':
    case 'email':
    case 'phone':
    case 'json':
      return { kind: field.kind };
    case 'number':
      return {
        kind: 'number',
        ...(field.precision.trim() ? { precision: Number(field.precision) } : {}),
        ...(field.format !== 'plain' ? { format: field.format } : {}),
        ...(field.isArray ? { isArray: true } : {}),
      };
    case 'date':
      return { kind: 'date', ...(field.includesTime ? { includesTime: true } : {}) };
    case 'select':
    case 'multiSelect':
      return {
        kind: field.kind,
        options: field.options
          .filter((option) => option.name.trim())
          .map((option) => ({
            name: option.name.trim(),
            ...(option.color.trim() ? { color: option.color.trim() } : {}),
          })),
      };
    case 'currency':
      return {
        kind: 'currency',
        currencyCode: field.currencyCode.trim().toUpperCase(),
        ...(field.precision.trim() ? { precision: Number(field.precision) } : {}),
      };
    case 'foreignKey':
      return {
        kind: 'foreignKey',
        target:
          field.foreignKeyTargetMode === 'ref'
            ? { ref: field.foreignKeyRef.trim() }
            : { existingRemoteTableId: splitRemoteId(field.foreignKeyExistingRemoteTableId) },
        ...(field.foreignKeyAllowMultiple ? { allowMultiple: true } : {}),
      };
    default:
      return assertUnreachable(field.kind);
  }
}

/** Order-insensitive structural equality for plain JSON values (field types built in different key orders). */
function areJsonValuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter((key) => rightRecord[key] !== undefined);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => areJsonValuesEqual(leftRecord[key], rightRecord[key]))
  );
}

/**
 * The plan's native type for this field, while the field's logical type is still exactly the one the plan
 * generated it with — see {@link EditorField.nativeFieldTypeFromPlan}. Null once the data type was edited.
 */
export function nativeFieldTypeStillApplying(field: EditorField): NativeFieldType | null {
  const nativeFieldTypeFromPlan = field.nativeFieldTypeFromPlan;
  if (!nativeFieldTypeFromPlan) return null;
  return areJsonValuesEqual(toCreateFieldType(field), nativeFieldTypeFromPlan.generatedWithFieldType)
    ? nativeFieldTypeFromPlan.nativeFieldType
    : null;
}

export function toCreateFieldSpec(field: EditorField): CreateFieldSpec {
  const nativeFieldType = nativeFieldTypeStillApplying(field);
  return {
    name: field.name.trim(),
    fieldType: toCreateFieldType(field),
    ...(nativeFieldType ? { nativeFieldType } : {}),
    ...(field.description.trim() ? { description: field.description.trim() } : {}),
    ...(field.required ? { required: true } : {}),
    ...(field.isPrimary ? { isPrimary: true } : {}),
    ...(field.isSourceRecordId ? { isSourceRecordId: true } : {}),
  };
}

export function toCreateTablesDto(params: {
  connectorAccountId: string;
  tables: EditorTable[];
  materializeLocally: boolean;
  remoteParentId: string;
  parentFolderId: string;
}): CreateSchemaTablesDto {
  return {
    connectorAccountId: params.connectorAccountId,
    ...(params.remoteParentId.trim() ? { remoteParentId: splitRemoteId(params.remoteParentId) } : {}),
    tables: params.tables.map((table) => ({
      name: table.name.trim(),
      ref: table.ref.trim(),
      fields: table.fields.map(toCreateFieldSpec),
    })),
    ...(params.materializeLocally ? { materializeLocally: true } : {}),
    ...(params.parentFolderId.trim() ? { parentFolderId: params.parentFolderId.trim() } : {}),
  };
}

export function toCreateFieldsDto(params: {
  connectorAccountId: string;
  /** Already-resolved remote table id (e.g. a data folder's `tableId`). */
  remoteTableId: string[];
  fields: EditorField[];
}): CreateSchemaFieldsDto {
  return {
    connectorAccountId: params.connectorAccountId,
    remoteTableId: params.remoteTableId,
    fields: params.fields.map(toCreateFieldSpec),
    refreshLocalSchema: true,
  };
}

/** Format a zod issue path as the server does (e.g. `fields[2].name`). */
export function formatIssuePath(path: ReadonlyArray<PropertyKey>): string {
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    const key = typeof segment === 'symbol' ? segment.toString() : segment;
    return acc ? `${acc}.${key}` : key;
  }, '');
}

/**
 * Adapt zod `.issues` (from a client-side `safeParse`) to the same
 * `ValidateSchemaIssue` shape the server's /validate endpoint returns, so both
 * paths render through one results component. Prefers the stable `params.code`
 * the shared schemas attach to custom refinements.
 */
export function zodIssuesToValidateIssues(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string; code: string }>,
): ValidateSchemaIssue[] {
  return issues.map((issue) => ({
    path: formatIssuePath(issue.path),
    code: ((issue as { params?: { code?: unknown } }).params?.code as string | undefined) ?? issue.code,
    message: issue.message,
  }));
}

// ── inverse mapping: a generated plan (wire DTO) → editor state ────────────────
// Used by the "Copy from folder" action to prefill the form from
// SchemaBuilderController.planFromFolder()'s output.

/** Build an editor field from a wire CreateFieldSpec (inverse of toCreateFieldSpec). */
export function editorFieldFromSpec(spec: CreateFieldSpec): EditorField {
  const editor: EditorField = {
    ...makeEmptyField(),
    name: spec.name,
    kind: spec.fieldType.kind,
    isPrimary: spec.isPrimary ?? false,
    required: spec.required ?? false,
    isSourceRecordId: spec.isSourceRecordId ?? false,
    description: spec.description ?? '',
    nativeFieldTypeFromPlan: spec.nativeFieldType
      ? { nativeFieldType: spec.nativeFieldType, generatedWithFieldType: spec.fieldType }
      : null,
  };
  const fieldType = spec.fieldType;
  switch (fieldType.kind) {
    case 'text':
    case 'boolean':
      editor.isArray = fieldType.isArray ?? false;
      break;
    case 'number':
      editor.precision = fieldType.precision != null ? String(fieldType.precision) : '';
      editor.format = fieldType.format ?? 'plain';
      editor.isArray = fieldType.isArray ?? false;
      break;
    case 'date':
      editor.includesTime = fieldType.includesTime ?? false;
      break;
    case 'select':
    case 'multiSelect':
      editor.options = fieldType.options.map((option) => ({
        ...makeEmptyChoiceOption(),
        name: option.name,
        color: option.color ?? '',
      }));
      break;
    case 'currency':
      editor.currencyCode = fieldType.currencyCode;
      editor.precision = fieldType.precision != null ? String(fieldType.precision) : '';
      break;
    case 'foreignKey':
      editor.foreignKeyAllowMultiple = fieldType.allowMultiple ?? false;
      if ('ref' in fieldType.target) {
        editor.foreignKeyTargetMode = 'ref';
        editor.foreignKeyRef = fieldType.target.ref;
      } else if ('existingRemoteTableId' in fieldType.target) {
        editor.foreignKeyTargetMode = 'existing';
        editor.foreignKeyExistingRemoteTableId = fieldType.target.existingRemoteTableId.join('/');
      }
      // A pending `{ unresolvedLinkedTableId }` target (the plan recognized the FK but
      // no destination table is chosen yet) leaves the picker empty in the default
      // 'existing' mode, so the user binds it to a table before creating.
      break;
    default:
      // Plain kinds (longText/url/email/phone/json) carry no extra inputs.
      break;
  }
  return editor;
}

/** Build an editor table from a wire CreateTableSpec, preserving its `ref`. */
export function editorTableFromSpec(spec: CreateTableSpec): EditorTable {
  return {
    id: nextEditorId('table'),
    name: spec.name,
    ref: spec.ref,
    fields: spec.fields.length ? spec.fields.map(editorFieldFromSpec) : [makeEmptyField()],
  };
}

/**
 * Build editor fields from wire CreateFieldSpecs — used to seed the add-fields
 * editor from a `CreateSchemaFieldsPlan` (the diff against an existing table).
 * Falls back to a single empty field when the diff found nothing to add.
 */
export function editorFieldsFromSpecs(specs: CreateFieldSpec[]): EditorField[] {
  return specs.length ? specs.map(editorFieldFromSpec) : [makeEmptyField()];
}

export interface SeededCreateTablesForm {
  tables: EditorTable[];
  remoteParentId: string;
}

/** Convert a generated CreateSchemaTablesDto plan into editor state for prefilling. */
export function fromCreateTablesDto(dto: CreateSchemaTablesDto): SeededCreateTablesForm {
  return {
    tables: dto.tables.length ? dto.tables.map(editorTableFromSpec) : [makeEmptyTable()],
    remoteParentId: dto.remoteParentId?.join('/') ?? '',
  };
}
