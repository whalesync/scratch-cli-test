import {
  autocompletion,
  pickedCompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from '@codemirror/autocomplete';
import type { Extension, Line, Text } from '@codemirror/state';
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

/** A sync the user can reference from a `sync:` field on a sync step. */
export interface RoutineSyncOption {
  /** SyncId (`syn_…`) — the value we insert (the routine `sync:` field takes only the id). */
  id: string;
  /** Human-readable sync name — shown as the dim detail (syncs have auto-generated names). */
  displayName: string;
}

/** Live data the completion source reads on every keystroke via the getter passed to the factory. */
export interface RoutineCompletionData {
  /** RoutineAction wire values: `discard-pending-changes`, `pull`, `sync`, `publish-plan`, `publish`. */
  actions: readonly string[];
  connections: readonly RoutineConnectionOption[];
  folders: readonly RoutineFolderOption[];
  syncs: readonly RoutineSyncOption[];
}

/** A one-line description of each action, shown as the completion's dim detail. */
const ACTION_DETAIL_BY_WIRE_VALUE: Record<string, string> = {
  'discard-pending-changes': 'Pre-flight: clear leftover unpublished edits before syncing',
  pull: 'Pull records from the connected service',
  sync: 'Copy & transform records between folders',
  'publish-plan': 'Preview changes to publish (no writes)',
  publish: 'Publish approved changes to the service',
};

/** A key completion spec: either a plain `insert` (+ optional value chaining) or a fully custom
 *  `customApply` (used by `options`, which scaffolds a nested map at the right indentation). */
interface RoutineKeySpec {
  label: string;
  detail: string;
  insert?: string;
  thenComplete?: boolean;
  boost?: number;
  customApply?: (view: EditorView, completion: Completion, from: number, to: number) => void;
  /** When set, the key is only offered for these actions (or when the step's action isn't known yet). */
  onlyForActions?: ReadonlyArray<string>;
  /** When set, the key is hidden for these actions (e.g. `folder`/`connection` are invalid on sync steps). */
  hiddenForActions?: ReadonlyArray<string>;
}

/** Step field keys, in the order we surface them. `thenComplete` chains into that field's value list. */
const STEP_FIELD_KEY_SPECS: ReadonlyArray<RoutineKeySpec> = [
  { label: 'action', detail: 'What this step does (required)', insert: 'action: ', thenComplete: true, boost: 1 },
  {
    label: 'folder',
    detail: 'Target folder — path or data folder id (publish steps)',
    insert: 'folder: ',
    thenComplete: true,
    onlyForActions: ['publish', 'publish-plan'],
  },
  {
    label: 'folders',
    detail: 'Target folders — a list of paths or data folder ids (pull steps)',
    customApply: applyFoldersScaffold,
    onlyForActions: ['pull'],
  },
  {
    label: 'connection',
    detail: 'Target connection — name or coa_…',
    insert: 'connection: ',
    thenComplete: true,
    // Hidden on sync (targets a sync) and discard (always workbook-wide — it takes no connection).
    hiddenForActions: ['sync', 'discard-pending-changes'],
  },
  {
    label: 'sync',
    detail: 'Sync to run — a syn_… id (sync steps only)',
    insert: 'sync: ',
    thenComplete: true,
    onlyForActions: ['sync'],
  },
  { label: 'options', detail: 'Action-specific settings (e.g. fullPull)', customApply: applyOptionsScaffold },
  { label: 'name', detail: 'Optional step label', insert: 'name: ', thenComplete: false },
  { label: 'comment', detail: 'Optional note', insert: 'comment: ', thenComplete: false },
  { label: 'timeout', detail: 'Optional per-step timeout in seconds', insert: 'timeout: ', thenComplete: false },
];

/** Top-level keys. `steps` scaffolds the first list item and chains into the step-field list. */
const TOP_LEVEL_KEY_SPECS: ReadonlyArray<RoutineKeySpec> = [
  { label: 'name', detail: 'Routine name (required)', insert: 'name: ', thenComplete: false, boost: 1 },
  { label: 'steps', detail: 'List of steps (required)', insert: 'steps:\n  - ', thenComplete: true },
  { label: 'schedule', detail: 'Cron schedule (optional)', insert: 'schedule: ', thenComplete: false },
  { label: 'comment', detail: 'Optional note', insert: 'comment: ', thenComplete: false },
];

/** One action-specific step option: the YAML key plus its dim detail. */
interface RoutineOptionSpec {
  label: string;
  detail: string;
}

/**
 * Action-specific step options keyed by RoutineAction wire value — mirrors `RoutineStepOptions` in
 * `@spinner/shared-types`. Adding a new option here is all it takes to surface it in the editor.
 * Actions with an empty list (sync / publish*) have no options today.
 */
const OPTION_SPECS_BY_ACTION: Record<string, ReadonlyArray<RoutineOptionSpec>> = {
  'discard-pending-changes': [],
  pull: [{ label: 'fullPull', detail: 'Force a full re-pull instead of the default incremental' }],
  sync: [],
  'publish-plan': [],
  publish: [],
};

/** Every option across actions, de-duplicated by label — offered when the step's action isn't known yet. */
const ALL_OPTION_SPECS: ReadonlyArray<RoutineOptionSpec> = Object.values(OPTION_SPECS_BY_ACTION)
  .flat()
  .filter((spec, index, all) => all.findIndex((other) => other.label === spec.label) === index);

/** Option keys whose value is a boolean — so we offer true/false after the colon. */
const BOOLEAN_OPTION_LABELS = new Set<string>(['fullPull']);

const BOOLEAN_VALUE_OPTIONS: Completion[] = [
  { label: 'true', type: 'keyword' },
  { label: 'false', type: 'keyword' },
];

// Value contexts: the `key:` is already on the line, so we complete what comes after it. The leading `-?`
// on the action matcher lets it fire both inline (`- action: pu`) and on a field line (`action: pu`).
const ACTION_VALUE_LINE = /^[ \t]*-?[ \t]*action:[ \t]*(\S*)$/;
const FOLDER_VALUE_LINE = /^[ \t]*folder:[ \t]*(\S*)$/;
// A YAML list item (`- <value>`) — used to offer folder values when the item sits under a `folders:` key.
const FOLDERS_ITEM_VALUE_LINE = /^[ \t]*-[ \t]*(\S*)$/;
const CONNECTION_VALUE_LINE = /^[ \t]*connection:[ \t]*(\S*)$/;
const SYNC_VALUE_LINE = /^[ \t]*-?[ \t]*sync:[ \t]*(\S*)$/;
// An indented `<key>: <value>` line — used to offer boolean values for known option keys (e.g. `fullPull`).
const NESTED_KEY_VALUE_LINE = /^[ \t]+([A-Za-z][A-Za-z0-9]*):[ \t]*(\S*)$/;

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

/** Builds a key completion that inserts `<key>: ` (or runs a custom scaffold) and chains where useful. */
function buildKeyCompletion(spec: RoutineKeySpec): Completion {
  return {
    label: spec.label,
    type: 'property',
    detail: spec.detail,
    boost: spec.boost,
    apply:
      spec.customApply ?? applyInsertThenMaybeComplete(spec.insert ?? `${spec.label}: `, spec.thenComplete ?? false),
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

function buildSyncValueOptions(data: RoutineCompletionData): Completion[] {
  // The routine `sync:` field takes only the SyncId, so we insert the id (the label) and surface the
  // human-readable name as the dim detail.
  return data.syncs.map((sync) => ({
    label: sync.id,
    type: 'variable',
    detail: sync.displayName || undefined,
  }));
}

/** Width of a line's leading whitespace — used to compare YAML nesting depth. */
function leadingWhitespaceWidth(text: string): number {
  return /^[ \t]*/.exec(text)?.[0].length ?? 0;
}

/**
 * Finds the `action:` of the routine step that contains `fromLine`, scanning upward. Returns the wire
 * action (e.g. `pull`) or null when there's no action above this point in the step (not typed yet, or
 * written below). Stops at the step's `- ` list-item boundary so it never leaks a neighbouring step's action.
 */
function findStepActionForLine(doc: Text, fromLine: Line): string | null {
  for (let lineNumber = fromLine.number; lineNumber >= 1; lineNumber--) {
    const text = doc.line(lineNumber).text;
    if (lineNumber !== fromLine.number && text.trim() === '') continue;
    const actionMatch = /^[ \t]*-?[ \t]*action:[ \t]*(\S+)/.exec(text);
    if (actionMatch) return actionMatch[1];
    // A `- ` line above the cursor starts this (action-less) step or a previous one — either way the
    // current step's action isn't above here.
    if (lineNumber !== fromLine.number && /^[ \t]*-/.test(text)) return null;
  }
  return null;
}

/**
 * When `currentLine` is nested directly under an `options:` mapping, returns the enclosing step's
 * action (or null when unknown); otherwise returns null. "Nested under options" means the nearest
 * preceding line with shallower indentation is an `options:` key carrying no inline value.
 */
function findEnclosingOptionsContext(doc: Text, currentLine: Line): { action: string | null } | null {
  const currentIndent = leadingWhitespaceWidth(currentLine.text);
  for (let lineNumber = currentLine.number - 1; lineNumber >= 1; lineNumber--) {
    const ancestor = doc.line(lineNumber);
    if (ancestor.text.trim() === '') continue;
    if (leadingWhitespaceWidth(ancestor.text) >= currentIndent) continue;
    // First strictly-shallower line is our YAML parent.
    if (/^[ \t]*options:[ \t]*$/.test(ancestor.text)) {
      return { action: findStepActionForLine(doc, ancestor) };
    }
    return null;
  }
  return null;
}

/**
 * When `currentLine` is a YAML list item nested directly under a `folders:` mapping, returns true.
 * "Nested under folders" means the nearest preceding line with shallower indentation is a `folders:`
 * key carrying no inline value — mirrors {@link findEnclosingOptionsContext}.
 */
function isLineNestedUnderFoldersKey(doc: Text, currentLine: Line): boolean {
  const currentIndent = leadingWhitespaceWidth(currentLine.text);
  for (let lineNumber = currentLine.number - 1; lineNumber >= 1; lineNumber--) {
    const ancestor = doc.line(lineNumber);
    if (ancestor.text.trim() === '') continue;
    // Sibling list items sit at the same indent — keep scanning past them to the parent key.
    if (leadingWhitespaceWidth(ancestor.text) >= currentIndent) continue;
    // First strictly-shallower line is our YAML parent.
    return /^[ \t]*folders:[ \t]*$/.test(ancestor.text);
  }
  return false;
}

/** The `folders:` step-key scaffold: inserts `folders:` + the first nested `- ` item and opens the folder list. */
function applyFoldersScaffold(view: EditorView, completion: Completion, from: number, to: number): void {
  // Nest list items two columns past where `folders` begins, regardless of the step's own indentation.
  const line = view.state.doc.lineAt(from);
  const nestedIndent = ' '.repeat(from - line.from + 2);
  const insert = `folders:\n${nestedIndent}- `;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    annotations: pickedCompletion.of(completion),
  });
  startCompletion(view);
}

/** The `options:` step-key scaffold: inserts `options:` + a nested indent and opens the option-key list. */
function applyOptionsScaffold(view: EditorView, completion: Completion, from: number, to: number): void {
  // Nest option keys two columns past where `options` begins, regardless of the step's own indentation.
  const line = view.state.doc.lineAt(from);
  const nestedIndent = ' '.repeat(from - line.from + 2);
  const insert = `options:\n${nestedIndent}`;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    annotations: pickedCompletion.of(completion),
  });
  startCompletion(view);
}

/** Builds an option-key completion that inserts `<key>: ` and chains into its value list (true/false). */
function buildOptionKeyCompletion(spec: RoutineOptionSpec): Completion {
  return {
    label: spec.label,
    type: 'property',
    detail: spec.detail,
    apply: applyInsertThenMaybeComplete(`${spec.label}: `, true),
  };
}

/** Options valid for an action — all of them when the action isn't known yet (so the user isn't blocked). */
function optionSpecsForAction(action: string | null): ReadonlyArray<RoutineOptionSpec> {
  return action === null ? ALL_OPTION_SPECS : (OPTION_SPECS_BY_ACTION[action] ?? []);
}

/** Whether to surface the `options` step key at all — hidden for actions that define no options. */
function actionSupportsOptions(action: string | null): boolean {
  return action === null || (OPTION_SPECS_BY_ACTION[action]?.length ?? 0) > 0;
}

/**
 * Whether a step-field key should be offered for the enclosing step's action. `options` follows the
 * action→options map; an `onlyForActions` allowlist (e.g. `sync`) shows only for those actions; a
 * `hiddenForActions` denylist (e.g. `folder`/`connection` on a sync step) hides for those actions; an
 * unknown action shows everything so the user is never blocked.
 */
function isStepKeyVisibleForAction(spec: RoutineKeySpec, action: string | null): boolean {
  if (spec.label === 'options') {
    return actionSupportsOptions(action);
  }
  if (spec.onlyForActions) {
    return action === null || spec.onlyForActions.includes(action);
  }
  if (spec.hiddenForActions) {
    return action === null || !spec.hiddenForActions.includes(action);
  }
  return true;
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

    const syncValueMatch = SYNC_VALUE_LINE.exec(textBeforeCursor);
    if (syncValueMatch) {
      const options = buildSyncValueOptions(data);
      if (options.length === 0 && !context.explicit) {
        return null;
      }
      return buildValueResult(context, syncValueMatch[1], options);
    }

    // A known boolean option key awaiting its value (e.g. `      fullPull: tr`) completes to true/false.
    const nestedValueMatch = NESTED_KEY_VALUE_LINE.exec(textBeforeCursor);
    if (nestedValueMatch && BOOLEAN_OPTION_LABELS.has(nestedValueMatch[1])) {
      return buildValueResult(context, nestedValueMatch[2], BOOLEAN_VALUE_OPTIONS);
    }

    // A list item (`- /blog`) nested under a `folders:` key offers the same folder values as `folder:`.
    // Checked before the step-field-key handling so a bare `- ` under `folders:` doesn't fall through to
    // the step-key list. A `- ` that is NOT under `folders:` (a step list item) is left to that handler.
    const foldersItemMatch = FOLDERS_ITEM_VALUE_LINE.exec(textBeforeCursor);
    if (foldersItemMatch && isLineNestedUnderFoldersKey(context.state.doc, line)) {
      const options = buildFolderValueOptions(data);
      if (options.length === 0 && !context.explicit) {
        return null;
      }
      return buildValueResult(context, foldersItemMatch[1], options);
    }

    const stepFieldKeyMatch = STEP_FIELD_KEY_LINE.exec(textBeforeCursor);
    if (stepFieldKeyMatch) {
      const hasDash = Boolean(stepFieldKeyMatch[1]);
      const typedKey = stepFieldKeyMatch[2];

      // An indented bare-word line nested under `options:` completes OPTION keys (filtered to the
      // enclosing step's action), not step fields. Option children never carry a `- `, so a dashed
      // line is always a step item.
      if (!hasDash) {
        const optionsContext = findEnclosingOptionsContext(context.state.doc, line);
        if (optionsContext) {
          const optionSpecs = optionSpecsForAction(optionsContext.action);
          if (optionSpecs.length === 0 && !context.explicit) {
            return null;
          }
          return buildKeyResult(context, typedKey, optionSpecs.map(buildOptionKeyCompletion));
        }
      }

      // Offer only the keys valid for this step's action — e.g. `sync` on a sync step, `options` on a
      // pull step. An unknown action shows everything so the user is never blocked.
      const stepAction = findStepActionForLine(context.state.doc, line);
      const options = STEP_FIELD_KEY_SPECS.filter((spec) => isStepKeyVisibleForAction(spec, stepAction)).map(
        buildKeyCompletion,
      );
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
