import {
  autocompletion,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

/**
 * Context-aware autocomplete for the routine YAML editor (see RoutineEditor.tsx).
 *
 * The routine schema is flat — top-level keys plus one level of step fields — so instead of walking
 * lang-yaml's Lezer tree we decide which suggestion list to show by matching the current line up to the
 * cursor with a few regexes (mirroring how RoutineEditor already parses `name:` with a line regex). The
 * source closes over a `getData` *getter* (not a snapshot) so it always reads the freshest connections /
 * folders without the editor having to reconfigure when SWR revalidates — see RoutineEditor for the wiring.
 */

/** A connection the user can reference from a step's `connection:` field. */
export interface RoutineConnectionOption {
  /** ConnectorAccountId (`coa_…`) — shown as a hint, never inserted. */
  id: string;
  /** Human-readable connection name — the value we insert. */
  displayName: string;
  /** Service slug, e.g. `airtable` — shown as the dim detail. */
  service: string;
}

/** A data folder the user can reference from a step's `folder:` field. */
export interface RoutineFolderOption {
  /** DataFolderId (`dfd_…`) — shown as a hint; only inserted when `path` is null. */
  id: string;
  /** POSIX path, e.g. `/blog/posts` — the value we insert when present. */
  path: string | null;
  name: string;
  /** Owning connection's display name — part of the dim detail. */
  connectorDisplayName: string | null;
  /** Owning connection's service slug — part of the dim detail. */
  connectorService: string | null;
}

/** Live data the completion source reads on every keystroke via the getter passed to the factory. */
export interface RoutineCompletionData {
  /** RoutineAction wire values: `pull`, `sync`, `publish-plan`, `publish`. */
  actions: readonly string[];
  connections: readonly RoutineConnectionOption[];
  folders: readonly RoutineFolderOption[];
}

/** A one-line description of each action, shown as the completion's dim detail. */
const ACTION_DETAIL_BY_WIRE_VALUE: Record<string, string> = {
  pull: 'Pull records from the connected service',
  sync: 'Copy & transform records between folders',
  'publish-plan': 'Preview changes to publish (no writes)',
  publish: 'Publish approved changes to the service',
};

/** Step field keys, in the order we surface them. `thenComplete` chains into that field's value list. */
const STEP_FIELD_KEY_SPECS: ReadonlyArray<{
  label: string;
  detail: string;
  insert: string;
  thenComplete: boolean;
  boost?: number;
}> = [
  { label: 'action', detail: 'What this step does (required)', insert: 'action: ', thenComplete: true, boost: 1 },
  { label: 'folder', detail: 'Target folder — path or dfd_…', insert: 'folder: ', thenComplete: true },
  { label: 'connection', detail: 'Target connection — name or coa_…', insert: 'connection: ', thenComplete: true },
  { label: 'name', detail: 'Optional step label', insert: 'name: ', thenComplete: false },
  { label: 'comment', detail: 'Optional note', insert: 'comment: ', thenComplete: false },
  { label: 'timeout', detail: 'Optional per-step timeout in seconds', insert: 'timeout: ', thenComplete: false },
];

/** Top-level keys. `steps` scaffolds the first list item and chains into the step-field list. */
const TOP_LEVEL_KEY_SPECS: ReadonlyArray<{
  label: string;
  detail: string;
  insert: string;
  thenComplete: boolean;
  boost?: number;
}> = [
  { label: 'name', detail: 'Routine name (required)', insert: 'name: ', thenComplete: false, boost: 1 },
  { label: 'steps', detail: 'List of steps (required)', insert: 'steps:\n  - ', thenComplete: true },
  { label: 'schedule', detail: 'Cron schedule (optional)', insert: 'schedule: ', thenComplete: false },
  { label: 'comment', detail: 'Optional note', insert: 'comment: ', thenComplete: false },
];

// Value contexts: the `key:` is already on the line, so we complete what comes after it. The leading `-?`
// on the action matcher lets it fire both inline (`- action: pu`) and on a field line (`action: pu`).
const ACTION_VALUE_LINE = /^[ \t]*-?[ \t]*action:[ \t]*(\S*)$/;
const FOLDER_VALUE_LINE = /^[ \t]*folder:[ \t]*(\S*)$/;
const CONNECTION_VALUE_LINE = /^[ \t]*connection:[ \t]*(\S*)$/;

// Key contexts: a bare word with no colon yet. A step field is indented (optionally after a `- `); a
// top-level key sits at column 0.
const STEP_FIELD_KEY_LINE = /^[ \t]+(-[ \t]*)?([A-Za-z]*)$/;
const TOP_LEVEL_KEY_LINE = /^([A-Za-z]*)$/;

// Keep the popup live (filter, don't re-query) while the user types value characters (paths, ids) or key
// characters. Paths/ids use `/`, `.`, `-`; `\w` covers letters, digits and `_`.
const VALUE_VALID_FOR = /^[\w./-]*$/;
const KEY_VALID_FOR = /^[A-Za-z]*$/;

/** Inserts `text`, places the cursor at its end, records the pick, and optionally re-opens the popup. */
function applyInsertThenMaybeComplete(insertText: string, thenComplete: boolean) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    view.dispatch({
      changes: { from, to, insert: insertText },
      selection: { anchor: from + insertText.length },
      annotations: pickedCompletion.of(completion),
    });
    if (thenComplete) {
      startCompletion(view);
    }
  };
}

/** Builds a key completion that inserts `<key>: ` (or a custom scaffold) and chains where useful. */
function buildKeyCompletion(spec: {
  label: string;
  detail: string;
  insert: string;
  thenComplete: boolean;
  boost?: number;
}): Completion {
  return {
    label: spec.label,
    type: 'property',
    detail: spec.detail,
    boost: spec.boost,
    apply: applyInsertThenMaybeComplete(spec.insert, spec.thenComplete),
  };
}

/** The "new step" scaffold: inserts `- action: ` and immediately opens the action shortlist. */
function buildNewStepCompletion(): Completion {
  return {
    label: 'new step',
    type: 'text',
    detail: 'Insert "- action: " and pick an action',
    boost: 2,
    apply: applyInsertThenMaybeComplete('- action: ', true),
  };
}

function buildActionValueOptions(data: RoutineCompletionData): Completion[] {
  return data.actions.map((action) => ({
    label: action,
    type: 'keyword',
    detail: ACTION_DETAIL_BY_WIRE_VALUE[action],
  }));
}

function buildFolderValueOptions(data: RoutineCompletionData): Completion[] {
  return data.folders.map((folder) => {
    const insertedValue = folder.path ?? folder.id;
    const detail = [folder.connectorDisplayName, folder.connectorService].filter(Boolean).join(' · ');
    return {
      label: insertedValue,
      type: 'type',
      detail: detail || undefined,
      // We insert the readable path; surface the stable id as a hint. When there's no path we insert the
      // id, so show the folder name instead.
      info: folder.path ? folder.id : folder.name,
    };
  });
}

function buildConnectionValueOptions(data: RoutineCompletionData): Completion[] {
  return data.connections.map((connection) => ({
    label: connection.displayName,
    type: 'variable',
    detail: connection.service || undefined,
    info: connection.id,
  }));
}

function buildValueResult(context: CompletionContext, typedValue: string, options: Completion[]): CompletionResult {
  return { from: context.pos - typedValue.length, options, validFor: VALUE_VALID_FOR };
}

function buildKeyResult(context: CompletionContext, typedKey: string, options: Completion[]): CompletionResult {
  return { from: context.pos - typedKey.length, options, validFor: KEY_VALID_FOR };
}

/**
 * The completion source. Pure and React-free so it can be unit-tested against hand-built
 * {@link CompletionContext} instances; `getData` supplies the live action/folder/connection lists.
 */
export function routineCompletionSource(getData: () => RoutineCompletionData): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    const line = context.state.doc.lineAt(context.pos);
    const textBeforeCursor = line.text.slice(0, context.pos - line.from);
    const data = getData();

    const actionValueMatch = ACTION_VALUE_LINE.exec(textBeforeCursor);
    if (actionValueMatch) {
      return buildValueResult(context, actionValueMatch[1], buildActionValueOptions(data));
    }

    const folderValueMatch = FOLDER_VALUE_LINE.exec(textBeforeCursor);
    if (folderValueMatch) {
      const options = buildFolderValueOptions(data);
      if (options.length === 0 && !context.explicit) {
        return null;
      }
      return buildValueResult(context, folderValueMatch[1], options);
    }

    const connectionValueMatch = CONNECTION_VALUE_LINE.exec(textBeforeCursor);
    if (connectionValueMatch) {
      const options = buildConnectionValueOptions(data);
      if (options.length === 0 && !context.explicit) {
        return null;
      }
      return buildValueResult(context, connectionValueMatch[1], options);
    }

    const stepFieldKeyMatch = STEP_FIELD_KEY_LINE.exec(textBeforeCursor);
    if (stepFieldKeyMatch) {
      const hasDash = Boolean(stepFieldKeyMatch[1]);
      const typedKey = stepFieldKeyMatch[2];
      const options = STEP_FIELD_KEY_SPECS.map(buildKeyCompletion);
      // On a blank field line (no key typed, no dash yet) also offer the new-step scaffold; with a dash the
      // user is already inside a step item, so a second `- ` would be wrong.
      if (typedKey.length === 0 && !hasDash) {
        options.unshift(buildNewStepCompletion());
      }
      return buildKeyResult(context, typedKey, options);
    }

    const topLevelKeyMatch = TOP_LEVEL_KEY_LINE.exec(textBeforeCursor);
    if (topLevelKeyMatch) {
      return buildKeyResult(context, topLevelKeyMatch[1], TOP_LEVEL_KEY_SPECS.map(buildKeyCompletion));
    }

    return null;
  };
}

/** Wraps {@link routineCompletionSource} in a configured `autocompletion` extension for the editor. */
export function routineCompletionExtension(getData: () => RoutineCompletionData): Extension {
  return autocompletion({ override: [routineCompletionSource(getData)], activateOnTyping: true });
}
