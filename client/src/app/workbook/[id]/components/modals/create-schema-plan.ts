import { assertUnreachable } from '@/utils/helpers';
import {
  type CreateFieldKind,
  type CreateFieldSpec,
  type CreateFieldType,
  type CreateSchemaFieldsDto,
  type CreateSchemaTablesDto,
  type CreateTableSpec,
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
};

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
  description: string;
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
    description: '',
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
    case 'longText':
    case 'boolean':
    case 'url':
    case 'email':
    case 'phone':
      return { kind: field.kind };
    case 'number':
      return {
        kind: 'number',
        ...(field.precision.trim() ? { precision: Number(field.precision) } : {}),
        ...(field.format !== 'plain' ? { format: field.format } : {}),
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

export function toCreateFieldSpec(field: EditorField): CreateFieldSpec {
  return {
    name: field.name.trim(),
    fieldType: toCreateFieldType(field),
    ...(field.description.trim() ? { description: field.description.trim() } : {}),
    ...(field.required ? { required: true } : {}),
    ...(field.isPrimary ? { isPrimary: true } : {}),
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
    description: spec.description ?? '',
  };
  const fieldType = spec.fieldType;
  switch (fieldType.kind) {
    case 'number':
      editor.precision = fieldType.precision != null ? String(fieldType.precision) : '';
      editor.format = fieldType.format ?? 'plain';
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
      } else {
        editor.foreignKeyTargetMode = 'existing';
        editor.foreignKeyExistingRemoteTableId = fieldType.target.existingRemoteTableId.join('/');
      }
      break;
    default:
      // Plain kinds (text/longText/boolean/url/email/phone) carry no extra inputs.
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
