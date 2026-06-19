'use client';

import { Text13Regular, TextMono12Regular } from '@/app/components/base/text';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { useDataFolders } from '@/hooks/use-data-folders';
import { useRoutineRuns } from '@/hooks/use-routine-runs';
import { useSchedules } from '@/hooks/use-schedules';
import { SWR_KEYS } from '@/lib/api/keys';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { trackRoutineCreated, trackRoutineDeleted, trackRoutineTriggered, trackRoutineUpdated } from '@/lib/posthog';
import { useRoutineDraftStore } from '@/stores/routine-draft-store';
import { useSyncStore } from '@/stores/sync-store';
import { yaml } from '@codemirror/lang-yaml';
import { EditorView } from '@codemirror/view';
import { Alert, Badge, Box, Button, Group, Stack, Tooltip, useMantineColorScheme } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { RoutineAction, ScheduleAction, type RoutineFileContent, type WorkbookId } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import { AlertCircleIcon, ClockIcon, PlayIcon, SaveIcon, Trash2Icon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { RoutineScheduleModal, getRoutineScheduleLabel } from '../shared/RoutineScheduleModal';
import { routineCompletionExtension, type RoutineCompletionData } from '../shared/routine-completion-extension';
import { RoutineRunHistory } from './RoutineRunHistory';

interface RoutineEditorProps {
  workbookId: WorkbookId;
  /** The routine file name (e.g. "daily-sync.yaml"), or the literal "new" to create one. */
  fileName: string;
}

const ROUTINES_DIRECTORY = 'routines/';

/** Starting content for a brand-new routine. */
const NEW_ROUTINE_TEMPLATE = `name: My Routine
steps:
  - action: pull
    folder: /path/to/folder
`;

/**
 * Extracts the top-level `name:` value from routine YAML, mirroring how js-yaml parses it on the
 * server. Matches `name:` only at column 0 (indented step names and comment lines are ignored). For
 * a quoted value it takes the quoted contents; for an unquoted value it drops a trailing inline
 * comment (a `#` that begins the value or follows whitespace) — so `name: Foo # note` yields `Foo`.
 */
function parseTopLevelRoutineName(yamlContent: string): string {
  const match = yamlContent.match(/^name:[ \t]*(.*)$/m);
  if (!match) {
    return '';
  }
  const value = match[1].trim();
  if (!value) {
    return '';
  }

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const closingIndex = value.indexOf(quote, 1);
    return closingIndex === -1 ? value.slice(1) : value.slice(1, closingIndex);
  }

  // Unquoted: a leading `#`, or a `#` after whitespace, begins a YAML comment.
  if (value.startsWith('#')) {
    return '';
  }
  const commentMatch = value.match(/\s+#/);
  return commentMatch ? value.slice(0, commentMatch.index).trimEnd() : value;
}

/**
 * Turns a routine name into a safe `<slug>.yaml` file name. Light-touch so non-Latin names survive:
 * NFC-normalized and lowercased, whitespace runs become a single dash, and only characters that are
 * genuinely unsafe in a file path are removed — control characters and the cross-platform reserved
 * set (`" * / : < > ? \ |`). Dot runs are collapsed (a path may not contain `..`) and leading/
 * trailing dashes and dots are trimmed. Unicode letters/digits in any script are preserved, so
 * `日本語` or `Привет Мир` produce real file names. Returns '' when nothing usable remains.
 */
function slugifyToYamlFileName(routineName: string): string {
  // Cross-platform filesystem-reserved characters, by code point: " * / : < > ? \ |
  const reservedCodePoints = new Set([0x22, 0x2a, 0x2f, 0x3a, 0x3c, 0x3e, 0x3f, 0x5c, 0x7c]);
  const cleaned = Array.from(routineName.normalize('NFC').toLowerCase())
    .filter((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code <= 0x1f || code === 0x7f) {
        return false; // strip control characters
      }
      return !reservedCodePoints.has(code);
    })
    .join('');
  const slug = cleaned
    .replace(/\s+/g, '-') // whitespace runs → single dash
    .replace(/\.{2,}/g, '.') // collapse dot runs so the path can never contain ".."
    .replace(/-+/g, '-') // collapse repeated dashes
    .replace(/^[-.]+|[-.]+$/g, ''); // trim leading/trailing dashes and dots
  return slug ? `${slug}.yaml` : '';
}

export function RoutineEditor({ workbookId, fileName }: RoutineEditorProps) {
  const isCreate = fileName === 'new';
  const filePath = `${ROUTINES_DIRECTORY}${fileName}`;

  const router = useRouter();
  const { mutate } = useSWRConfig();
  const { colorScheme } = useMantineColorScheme();
  const { open: openConfirm, dialogProps } = useConfirmDialog();
  const setDraftFileName = useRoutineDraftStore((state) => state.setDraftFileName);

  // Latest connections/folders for the editor's autocomplete. Populated by the isolated
  // <RoutineCompletionDataSync> child below so that SWR revalidations of that data re-render only the
  // child — not this editor host. (A host re-render mid-edit can make @uiw/react-codemirror's controlled
  // `value` reconciliation overwrite the document and drop the user's latest keystrokes.) The built-once
  // completion source reads this ref on every keystroke.
  const completionDataRef = useRef<RoutineCompletionData>({ actions: [], connections: [], folders: [], syncs: [] });

  // The live editor view, captured on creation. We read its document at save time so a save always
  // persists exactly what the user sees — the controlled `content` state can briefly lag the document
  // around autocomplete acceptance.
  const editorViewRef = useRef<EditorView | null>(null);

  // Load the raw YAML for an existing routine; create mode starts from a template (no fetch).
  const {
    data: fileContent,
    error: fileError,
    isLoading,
  } = useSWR<RoutineFileContent, Error>(
    isCreate ? null : SWR_KEYS.routines.file(workbookId, filePath),
    () => scratchApiClient.routine.getFileContent(workbookId, filePath),
    { revalidateOnFocus: false },
  );

  // The run count drives the layout: once this routine has run history, the history panel grows to
  // take half the height (a 50/50 split with the editor). Shares SWR cache with the panel's own call.
  const { runs: routineRuns } = useRoutineRuns(isCreate ? null : workbookId, filePath);
  const hasRunHistory = routineRuns.length > 0;

  // The routine's schedule lives in the Schedule table (action ROUTINE, entityId = file path), not the
  // YAML (DEV-10478). Surface it so the toolbar shows the current frequency and can open the editor.
  const { schedules, refresh: refreshSchedules } = useSchedules(isCreate ? null : workbookId);
  const routineSchedule =
    schedules.find((schedule) => schedule.action === ScheduleAction.ROUTINE && schedule.entityId === filePath) ?? null;
  const [isScheduleModalOpen, setIsScheduleModalOpen] = useState(false);

  const [content, setContent] = useState('');
  const [savedContent, setSavedContent] = useState('');
  const [hasChanges, setHasChanges] = useState(false);
  const [isContentInitialized, setIsContentInitialized] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isTriggering, setIsTriggering] = useState(false);

  // Reset editor state whenever we navigate to a different routine (or to "new").
  useEffect(() => {
    setIsContentInitialized(false);
    setHasChanges(false);
    setSaveError(null);
  }, [fileName]);

  // In create mode the file name is generated live from the routine's `name:` field.
  const derivedFileName = useMemo(
    () => (isCreate ? slugifyToYamlFileName(parseTopLevelRoutineName(content)) : ''),
    [isCreate, content],
  );

  // Publish the projected file name so the sidebar can preview the routine before it's saved.
  useEffect(() => {
    setDraftFileName(isCreate ? derivedFileName || null : null);
  }, [isCreate, derivedFileName, setDraftFileName]);

  // Clear the preview on unmount so a stale draft never lingers in the sidebar.
  useEffect(() => () => setDraftFileName(null), [setDraftFileName]);

  // Initialize content: a template for create mode, the fetched file otherwise.
  useEffect(() => {
    if (isContentInitialized) return;
    if (isCreate) {
      setContent(NEW_ROUTINE_TEMPLATE);
      setSavedContent('');
      setHasChanges(true);
      setIsContentInitialized(true);
      return;
    }
    if (fileContent?.content !== undefined) {
      setContent(fileContent.content);
      setSavedContent(fileContent.content);
      setHasChanges(false);
      setIsContentInitialized(true);
    }
  }, [isCreate, fileContent, isContentInitialized]);

  const handleContentChange = useCallback(
    (newContent: string) => {
      setContent(newContent);
      setHasChanges(newContent !== savedContent);
      setSaveError(null);
    },
    [savedContent],
  );

  const handleSave = useCallback(async () => {
    setSaveError(null);

    // Persist exactly what's on screen: read the live editor document rather than the controlled
    // `content` state, which can briefly lag the document around autocomplete acceptance. Derive the
    // create-mode file name from the same text so the name and body never come from different snapshots.
    const contentToSave = editorViewRef.current?.state.doc.toString() ?? content;

    let targetPath: string;
    if (isCreate) {
      const generatedFileName = slugifyToYamlFileName(parseTopLevelRoutineName(contentToSave));
      if (!generatedFileName) {
        setSaveError('Give your routine a `name:` to generate a file name.');
        return;
      }
      targetPath = `${ROUTINES_DIRECTORY}${generatedFileName}`;
    } else {
      targetPath = filePath;
    }

    setIsSaving(true);
    try {
      if (isCreate) {
        await scratchApiClient.routine.createFile(workbookId, { path: targetPath, content: contentToSave });
        trackRoutineCreated(workbookId, targetPath);
      } else {
        await scratchApiClient.routine.updateFile(workbookId, { path: targetPath, content: contentToSave });
        trackRoutineUpdated(workbookId, targetPath);
      }
      setSavedContent(contentToSave);
      setHasChanges(false);
      await mutate(SWR_KEYS.routines.list(workbookId));
      notifications.show({
        title: isCreate ? 'Routine created' : 'Routine saved',
        message: targetPath,
        color: 'green',
      });
      if (isCreate) {
        router.push(`/workbook/${workbookId}/routines/${targetPath.slice(ROUTINES_DIRECTORY.length)}`);
      } else {
        await mutate(SWR_KEYS.routines.file(workbookId, targetPath));
      }
    } catch (err) {
      // The server rejects invalid YAML / bad paths with a clear message — surface it verbatim.
      const message = err instanceof Error ? err.message : 'Failed to save routine.';
      setSaveError(message);
      notifications.show({ title: 'Could not save routine', message, color: 'red' });
    } finally {
      setIsSaving(false);
    }
  }, [isCreate, filePath, content, workbookId, mutate, router]);

  const handleDelete = useCallback(() => {
    openConfirm({
      title: 'Delete routine',
      message: `Delete ${filePath}? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        try {
          await scratchApiClient.routine.deleteFile(workbookId, filePath);
          trackRoutineDeleted(workbookId, filePath);
          await mutate(SWR_KEYS.routines.list(workbookId));
          notifications.show({ title: 'Routine deleted', message: filePath, color: 'green' });
          router.push(`/workbook/${workbookId}/routines`);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to delete routine.';
          notifications.show({ title: 'Could not delete routine', message, color: 'red' });
        }
      },
    });
  }, [openConfirm, filePath, workbookId, mutate, router]);

  const handleRun = useCallback(async () => {
    setIsTriggering(true);
    try {
      await scratchApiClient.routine.trigger(workbookId, filePath);
      trackRoutineTriggered(workbookId, filePath);
      // Refresh the run history + the sidebar's last-run dot.
      await Promise.all([
        mutate(SWR_KEYS.routines.runs(workbookId, filePath)),
        mutate(SWR_KEYS.routines.list(workbookId)),
      ]);
      notifications.show({ title: 'Routine started', message: filePath, color: 'green' });
    } catch (err) {
      // 409 (already running) and other failures surface with the server's message verbatim.
      const message = err instanceof Error ? err.message : 'Failed to start routine.';
      notifications.show({ title: 'Could not start routine', message, color: 'red' });
    } finally {
      setIsTriggering(false);
    }
  }, [workbookId, filePath, mutate]);

  // After editing the schedule, refresh both the schedule list (drives the toolbar label) and the
  // routines list (drives the sidebar clock indicator).
  const handleScheduleSaved = useCallback(async () => {
    await Promise.all([refreshSchedules(), mutate(SWR_KEYS.routines.list(workbookId))]);
  }, [refreshSchedules, mutate, workbookId]);

  // Cmd+S / Ctrl+S to save.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleSave]);

  // Built once and kept stable; the completion source reads live data through the ref getter above.
  const extensions = useMemo(
    () => [yaml(), EditorView.lineWrapping, routineCompletionExtension(() => completionDataRef.current)],
    [],
  );

  const showLoading = !isCreate && isLoading && !isContentInitialized;
  const showNotFound = !isCreate && fileError && !isContentInitialized;

  return (
    <Stack h="100%" gap={0}>
      {/* Loads connections/folders for autocomplete in isolation so their async revalidations don't
          re-render (and disrupt) the editor. Renders nothing. */}
      <RoutineCompletionDataSync workbookId={workbookId} dataRef={completionDataRef} />

      {/* Header: file name (or new-file input) + actions */}
      <Group
        h={36}
        px="sm"
        justify="space-between"
        style={{ borderBottom: '0.5px solid var(--fg-divider)', flexShrink: 0, backgroundColor: 'var(--bg-base)' }}
      >
        <Group gap="sm" style={{ flex: 1, minWidth: 0 }}>
          {isCreate ? (
            derivedFileName ? (
              <Tooltip label="File name generated from the routine name" position="bottom">
                <TextMono12Regular c="var(--fg-primary)">{derivedFileName}</TextMono12Regular>
              </Tooltip>
            ) : (
              <Text13Regular c="dimmed">Add a name to generate a file name</Text13Regular>
            )
          ) : (
            <TextMono12Regular c="var(--fg-primary)">{fileName}</TextMono12Regular>
          )}
          {hasChanges && (
            <Badge size="xs" variant="light" color="blue">
              Unsaved
            </Badge>
          )}
        </Group>

        <Group gap="xs">
          {/* Edit the routine's schedule (stored in the Schedule table, action ROUTINE). The label
              shows the current frequency. Only for a saved routine — the schedule keys off its file path. */}
          {!isCreate && (
            <Tooltip label="Set when this routine runs automatically" position="bottom">
              <Button
                size="compact-xs"
                variant="default"
                leftSection={<ClockIcon size={12} />}
                onClick={() => setIsScheduleModalOpen(true)}
              >
                {getRoutineScheduleLabel(routineSchedule?.cronExpression ?? '')}
              </Button>
            </Tooltip>
          )}
          {/* Trigger a manual run. Only meaningful for a saved routine (a run reads the committed
              YAML), and disabled while there are unsaved edits so the user runs what they see. */}
          {!isCreate && (
            <Tooltip label={hasChanges ? 'Save your changes before running' : 'Run this routine now'} position="bottom">
              <Button
                size="compact-xs"
                variant="default"
                leftSection={<PlayIcon size={12} />}
                onClick={handleRun}
                loading={isTriggering}
                disabled={hasChanges}
              >
                Run
              </Button>
            </Tooltip>
          )}
          {!isCreate && (
            <Button
              size="compact-xs"
              variant="subtle"
              color="red"
              leftSection={<Trash2Icon size={12} />}
              onClick={handleDelete}
            >
              Delete
            </Button>
          )}
          <Button
            size="compact-xs"
            leftSection={<SaveIcon size={12} />}
            onClick={handleSave}
            loading={isSaving}
            disabled={isCreate ? !derivedFileName : !hasChanges}
          >
            {isCreate ? 'Create' : 'Save'}
          </Button>
        </Group>
      </Group>

      {/* Validation / save error surfaced from the server */}
      {saveError && (
        <Alert
          color="red"
          variant="light"
          icon={<AlertCircleIcon size={16} />}
          title="Could not save routine"
          withCloseButton
          onClose={() => setSaveError(null)}
          style={{ flexShrink: 0, borderRadius: 0 }}
        >
          {saveError}
        </Alert>
      )}

      {/* Editor / loading / not-found */}
      <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {showNotFound ? (
          <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Text13Regular c="dimmed">Routine not found</Text13Regular>
          </Box>
        ) : showLoading ? (
          <Box p="xl" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
            <Text13Regular c="dimmed">Loading routine...</Text13Regular>
          </Box>
        ) : (
          <CodeMirror
            value={content}
            onChange={handleContentChange}
            onCreateEditor={(view) => {
              editorViewRef.current = view;
            }}
            extensions={extensions}
            theme={colorScheme === 'dark' ? 'dark' : 'light'}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLineGutter: true,
              highlightSpecialChars: true,
              history: true,
              foldGutter: true,
              drawSelection: true,
              dropCursor: true,
              allowMultipleSelections: true,
              indentOnInput: true,
              syntaxHighlighting: true,
              bracketMatching: true,
              closeBrackets: true,
              // Custom routine-aware completion is supplied via the `extensions` array above; disable
              // basicSetup's default source so it doesn't register a second, empty one.
              autocompletion: false,
              rectangularSelection: true,
              crosshairCursor: true,
              highlightActiveLine: true,
              highlightSelectionMatches: true,
              closeBracketsKeymap: true,
              defaultKeymap: true,
              searchKeymap: true,
              historyKeymap: true,
              foldKeymap: true,
              completionKeymap: true,
              lintKeymap: true,
            }}
            style={{ fontSize: '13px', height: '100%' }}
          />
        )}
      </Box>

      {/* Run history (saved routines only). With history, it splits the space 50/50 with the editor
          (both flex:1); with no runs yet, it stays a small panel below the editor. */}
      {!isCreate && !showNotFound && (
        <Box
          style={{
            overflow: 'auto',
            borderTop: '0.5px solid var(--fg-divider)',
            backgroundColor: 'var(--bg-base)',
            ...(hasRunHistory ? { flex: 1, minHeight: 0 } : { flexShrink: 0, maxHeight: 280 }),
          }}
        >
          <RoutineRunHistory workbookId={workbookId} routineFilePath={filePath} />
        </Box>
      )}

      {!isCreate && (
        <RoutineScheduleModal
          opened={isScheduleModalOpen}
          onClose={() => setIsScheduleModalOpen(false)}
          workbookId={workbookId}
          routineFilePath={filePath}
          routineName={parseTopLevelRoutineName(content) || fileName}
          existingSchedule={routineSchedule}
          onSaved={handleScheduleSaved}
        />
      )}

      <ConfirmDialog {...dialogProps} />
    </Stack>
  );
}

/**
 * Subscribes to the workbook's connections, folders, and syncs and writes them into `dataRef` for the
 * editor's autocomplete. Rendered as `null` and kept separate from {@link RoutineEditor} on purpose: SWR
 * revalidations of this data then re-render only this component, never the editor host. If the editor
 * host re-rendered on those async loads, @uiw/react-codemirror's controlled-`value` reconciliation could
 * overwrite the document mid-edit (e.g. just after an autocomplete pick), desyncing it from what is saved.
 */
function RoutineCompletionDataSync({
  workbookId,
  dataRef,
}: {
  workbookId: WorkbookId;
  dataRef: MutableRefObject<RoutineCompletionData>;
}) {
  const { connectorAccounts } = useConnectorAccounts(workbookId);
  const { folders } = useDataFolders(workbookId);
  const syncs = useSyncStore((state) => state.syncs);
  const fetchSyncs = useSyncStore((state) => state.fetchSyncs);

  // Ensure syncs are loaded for a sync step's `sync:` autocomplete — the routines page can be opened
  // without the syncs view (which normally populates the store) ever having mounted.
  useEffect(() => {
    fetchSyncs(workbookId);
  }, [workbookId, fetchSyncs]);

  useEffect(() => {
    dataRef.current = {
      actions: Object.values(RoutineAction),
      connections: (connectorAccounts ?? []).map((connection) => ({
        id: connection.id,
        displayName: connection.displayName,
        service: connection.service,
      })),
      folders: (folders ?? []).map((folder) => ({
        id: folder.id,
        path: folder.path,
        name: folder.name,
        connectorDisplayName: folder.connectorDisplayName,
        connectorService: folder.connectorService,
      })),
      syncs: syncs.map((sync) => ({ id: sync.id, displayName: sync.displayName })),
    };
  }, [connectorAccounts, folders, syncs, dataRef]);

  return null;
}
