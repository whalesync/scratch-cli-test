'use client';

import { ModalWrapper } from '@/app/components/ModalWrapper';
import { useTransformerMetadata } from '@/hooks/use-transformer-metadata';
import { syncApi } from '@/lib/api/sync';
import { json } from '@codemirror/lang-json';
import { EditorView } from '@codemirror/view';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Flex,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  Tooltip,
  useMantineColorScheme,
} from '@mantine/core';
import type {
  DataFolder,
  DataFolderId,
  MappingTypeTraceResponse,
  TransformerConfig,
  WorkbookId,
} from '@spinner/shared-types';
import { getTransformerLabel } from '@spinner/shared-types';
import CodeMirror from '@uiw/react-codemirror';
import { AlertTriangle, ArrowRight, Code, Plus, X } from 'lucide-react';
import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { defaultConfigFromMetadata, TransformerStepFormGeneric } from './TransformerStepFormGeneric';

export interface MappingContextForValidation {
  workbookId: WorkbookId;
  sourceFolderId: DataFolderId;
  destFolderId: DataFolderId;
  sourceField: string;
  destField: string;
  /** Schema type for the source field (e.g. "string", "number") when available */
  sourceFieldType?: string;
  /** Schema type for the destination field when available */
  destFieldType?: string;
}

interface TransformerConfigModalProps {
  opened: boolean;
  onClose: () => void;
  currentConfigs: TransformerConfig[];
  onSave: (configs: TransformerConfig[]) => void;
  allFolders: DataFolder[];
  /** When set, enables the Validate button (admin only) to trace types for this mapping */
  mappingContext?: MappingContextForValidation | null;
}

/** Short label for a JSON Schema type (e.g. "string", "number", "array") */
function schemaTypeLabel(schema: Record<string, unknown> | undefined): string {
  if (!schema) return '—';
  const t = schema.type;
  if (typeof t === 'string') return t;
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0)
    return (schema.anyOf as Record<string, unknown>[]).map((s) => schemaTypeLabel(s)).join(' | ');
  return 'any';
}

/** Tooltip string for a step: inputLabel → outputLabel (or Error) */
function stepTypeTooltip(
  step:
    | { inputJsonSchemaType?: Record<string, unknown>; outputJsonSchemaType?: Record<string, unknown>; error?: string }
    | undefined,
  loading: boolean,
): string {
  if (loading) return '…';
  if (!step) return '—';
  const input = schemaTypeLabel(step.inputJsonSchemaType);
  if (step.error) return `${input} → Error`;
  const output = schemaTypeLabel(step.outputJsonSchemaType);
  return `${input} → ${output}`;
}

/** Wraps a pipeline node (Source, Step N, Destination) with a centered label above the bubble. */
function NodeWrapper({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Stack gap={2} align="center" style={{ width: 'fit-content', flexShrink: 0 }}>
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      {children}
    </Stack>
  );
}

const ARROW_WRAPPER_WIDTH = 24;
/** Min height for all pipeline bubbles (Source, Step, Destination) so they align. */
const BUBBLE_MIN_HEIGHT = 56;

/** Wraps the between-node slot: warning icon, arrow, plus button. Fixed width for alignment. */
function ArrowWrapper({
  validationError,
  isPlusHovered,
  onInsert,
  onMouseEnter,
  onMouseLeave,
}: {
  validationError?: string;
  isPlusHovered: boolean;
  onInsert: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  return (
    <Stack
      align="center"
      gap={2}
      style={{ width: ARROW_WRAPPER_WIDTH, flexShrink: 0 }}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <Box
        style={{
          width: 16,
          height: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Tooltip label={validationError} disabled={!validationError}>
          <Box
            component="span"
            style={{
              visibility: validationError ? 'visible' : 'hidden',
              display: 'inline-flex',
            }}
          >
            <AlertTriangle size={14} color="var(--mantine-color-yellow-6)" />
          </Box>
        </Tooltip>
      </Box>
      <ArrowRight size={16} color="var(--mantine-color-dimmed)" />
      <Tooltip label="Add a new transformer here">
        <ActionIcon
          size="xs"
          variant={isPlusHovered ? 'light' : 'subtle'}
          color={isPlusHovered ? 'blue' : 'gray'}
          onClick={onInsert}
        >
          <Plus size={12} />
        </ActionIcon>
      </Tooltip>
    </Stack>
  );
}

/**
 * Returns true if a transformer config has all required fields filled in (non-empty).
 * This is a lightweight check that doesn't require metadata — used by SyncEditor
 * and validation logic that doesn't have metadata loaded.
 */
export function isTransformerConfigComplete(config: TransformerConfig): boolean {
  const opts = config.options as Record<string, unknown> | undefined;
  if (!opts) return true;

  // Check common required fields by convention
  const requiredFieldsByType: Record<string, string[]> = {
    source_fk_to_dest_fk: ['referencedDataFolderId'],
    lookup_field: ['referencedDataFolderId', 'referencedFieldPath'],
    source_asset_to_dest_asset: ['sourceDataFolderId', 'destinationDataFolderId'],
    match_asset_by_hash: ['sourceDataFolderId', 'destinationDataFolderId'],
  };

  const requiredFields = requiredFieldsByType[config.type];
  if (!requiredFields) return true;
  return requiredFields.every((key) => !!opts[key]);
}

const sourceDestBorderStyle = { borderColor: 'var(--mantine-color-gray-8)' };

export function TransformerConfigModal({
  opened,
  onClose,
  currentConfigs,
  onSave,
  allFolders,
  mappingContext,
}: TransformerConfigModalProps) {
  const { metadata: transformerMetadata } = useTransformerMetadata();
  const [typeTrace, setTypeTrace] = useState<MappingTypeTraceResponse | { error: string } | null>(null);
  /** Raw result for admin submodal (includes error responses); main UI uses typeTrace (null when failed). */
  const [lastValidationResult, setLastValidationResult] = useState<MappingTypeTraceResponse | { error: string } | null>(
    null,
  );
  const [typeTraceLoading, setTypeTraceLoading] = useState(false);
  /** Index of step being edited; null = none. Edit form shown below flow when set. */
  const [editIndex, setEditIndex] = useState<number | null>(null);
  /** Hovered step index for showing remove/edit actions */
  const [hoveredStep, setHoveredStep] = useState<number | null>(null);
  /** Hovered plus slot (0 = before first step, currentConfigs.length = after last) for highlight */
  const [hoveredPlusSlot, setHoveredPlusSlot] = useState<number | null>(null);
  /** Admin-only: submodal showing raw validation result */
  const [validationResultModalOpen, setValidationResultModalOpen] = useState(false);
  /** Type display mode: none, output only, or input & output. Default output. */
  const [showTypesMode, setShowTypesMode] = useState<'no' | 'output' | 'input-and-output'>('output');
  const { colorScheme } = useMantineColorScheme();

  useEffect(() => {
    if (opened) {
      setTypeTrace(null);
      setLastValidationResult(null);
      setEditIndex(null);
      setHoveredStep(null);
      setHoveredPlusSlot(null);
      setValidationResultModalOpen(false);
    }
  }, [opened]);

  const insertAt = useCallback(
    (index: number) => {
      const next = [...currentConfigs];
      next.splice(index, 0, defaultConfigFromMetadata('auto_convert', transformerMetadata ?? []));
      onSave(next);
      setEditIndex(index);
    },
    [currentConfigs, onSave, transformerMetadata],
  );

  const removeAt = useCallback(
    (index: number) => {
      const next = currentConfigs.filter((_, i) => i !== index);
      onSave(next);
      if (editIndex === index) setEditIndex(null);
      else if (editIndex != null && editIndex > index) setEditIndex(editIndex - 1);
      setHoveredStep(null);
    },
    [currentConfigs, onSave, editIndex],
  );

  const updateAt = useCallback(
    (index: number, config: TransformerConfig) => {
      const next = [...currentConfigs];
      next[index] = config;
      onSave(next);
    },
    [currentConfigs, onSave],
  );

  // Validation is nice-to-have: never block the user. On any failure we simply don't show types.
  const runValidation = useCallback(async () => {
    if (!mappingContext) return;
    if (!currentConfigs.every(isTransformerConfigComplete)) return;
    setTypeTraceLoading(true);
    try {
      const result = await syncApi.validateMappingType(mappingContext.workbookId, {
        sourceFolderId: mappingContext.sourceFolderId,
        destFolderId: mappingContext.destFolderId,
        sourceColumnId: mappingContext.sourceField,
        destinationColumnId: mappingContext.destField,
        transformers: currentConfigs,
      });
      setLastValidationResult(result);
      // If the API returned an error in the body, don't show types in main UI; user can still create transforms/syncs.
      if (result && typeof result === 'object' && 'error' in result) {
        setTypeTrace(null);
      } else {
        setTypeTrace(result);
      }
    } catch {
      // Network/server error: don't show types; user can still create transforms and syncs.
      setLastValidationResult({ error: 'Validation request failed (e.g. network or server error).' });
      setTypeTrace(null);
    } finally {
      setTypeTraceLoading(false);
    }
  }, [mappingContext, currentConfigs]);

  const validationDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Run validation when modal opens or currentConfigs change (e.g. user edited mapping elsewhere)
  useEffect(() => {
    if (!opened || !mappingContext) return;
    if (validationDebounceRef.current) clearTimeout(validationDebounceRef.current);
    validationDebounceRef.current = setTimeout(() => {
      validationDebounceRef.current = null;
      runValidation();
    }, 300);
    return () => {
      if (validationDebounceRef.current) clearTimeout(validationDebounceRef.current);
    };
  }, [opened, mappingContext, currentConfigs, runValidation]);

  const sourceLabel = mappingContext?.sourceField ?? 'Source';
  const destLabel = mappingContext?.destField ?? 'Destination';
  const traceSteps = typeTrace && !('error' in typeTrace) ? typeTrace.steps : [];
  const validation = typeTrace && !('error' in typeTrace) ? typeTrace.validation : undefined;
  // Helpers to look up error messages from the flat validation array by step identifier
  const sourceValidationError = validation?.find((e) => e.step === 'source')?.errorMsg;
  const stepValidationError = (stepIndex: number) => validation?.find((e) => e.step === stepIndex)?.errorMsg;
  const sourceTypeLabel =
    typeTrace && !('error' in typeTrace)
      ? schemaTypeLabel(typeTrace.sourceType)
      : typeTraceLoading
        ? '…'
        : (mappingContext?.sourceFieldType ?? '—');
  const destTypeLabel =
    typeTrace && !('error' in typeTrace)
      ? schemaTypeLabel(typeTrace.destinationType)
      : typeTraceLoading
        ? '…'
        : (mappingContext?.destFieldType ?? '—');
  const addFirstTransformer = useCallback(
    (type: string) => {
      onSave([defaultConfigFromMetadata(type, transformerMetadata ?? [])]);
      setEditIndex(0);
    },
    [onSave, transformerMetadata],
  );

  const transformerSelectData = (transformerMetadata ?? []).map((m) => ({ value: m.type, label: m.label }));

  const modalTitle =
    mappingContext != null ? (
      <Group gap="xs">
        <span>Configure Transformers</span>
        <ActionIcon
          size="sm"
          variant="subtle"
          color="gray"
          title="View validation result (admin)"
          onClick={() => setValidationResultModalOpen(true)}
        >
          <Code size={14} />
        </ActionIcon>
      </Group>
    ) : (
      'Configure Transformers'
    );

  return (
    <>
      <ModalWrapper
        opened={opened}
        onClose={onClose}
        title={modalTitle}
        size={900}
        customProps={{
          footer: (
            <Group justify="space-between" w="100%">
              <Group gap="xs">
                <Text size="xs" fw={500}>
                  Show types
                </Text>
                <Select
                  size="xs"
                  w={140}
                  data={[
                    { value: 'no', label: 'No' },
                    { value: 'output', label: 'Output' },
                    { value: 'input-and-output', label: 'Input & Output' },
                  ]}
                  value={showTypesMode}
                  onChange={(v) => v && setShowTypesMode(v as 'no' | 'output' | 'input-and-output')}
                />
              </Group>
              <Button variant="default" onClick={onClose}>
                Close
              </Button>
            </Group>
          ),
        }}
      >
        <Stack gap="md">
          {/* Pipeline: centered when narrow, scrollable when wide */}
          <ScrollArea type="scroll" scrollbarSize={8} mah={180}>
            <Flex justify="center" style={{ minWidth: '100%' }}>
              <Flex gap="xs" wrap="nowrap" align="center" style={{ minWidth: 'min-content', flexShrink: 0 }}>
                <NodeWrapper label="Source">
                  <Paper
                    withBorder
                    p="xs"
                    radius="sm"
                    style={{
                      width: 'fit-content',
                      minWidth: 120,
                      minHeight: BUBBLE_MIN_HEIGHT,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      ...sourceDestBorderStyle,
                    }}
                  >
                    <Stack gap={2} align="center">
                      <Text size="xs" fw={600} lineClamp={1} title={sourceLabel}>
                        {sourceLabel}
                      </Text>
                      {(showTypesMode === 'output' || showTypesMode === 'input-and-output') && (
                        <Badge
                          size="xs"
                          variant="light"
                          color={showTypesMode === 'input-and-output' && sourceValidationError ? 'yellow' : 'gray'}
                        >
                          {sourceTypeLabel}
                        </Badge>
                      )}
                    </Stack>
                  </Paper>
                </NodeWrapper>

                <ArrowWrapper
                  validationError={sourceValidationError}
                  isPlusHovered={hoveredPlusSlot === 0}
                  onInsert={() => insertAt(0)}
                  onMouseEnter={() => setHoveredPlusSlot(0)}
                  onMouseLeave={() => setHoveredPlusSlot(null)}
                />

                {currentConfigs.map((config, index) => {
                  const traceStep = traceSteps[index];
                  const stepLabel = traceStep ? traceStep.transformerName : getTransformerLabel(config.type);
                  const stepError = traceStep?.error;
                  const stepInputLabel = traceStep
                    ? schemaTypeLabel(traceStep.inputJsonSchemaType)
                    : typeTraceLoading
                      ? '…'
                      : '—';
                  const stepOutputLabel = stepError
                    ? 'Error'
                    : traceStep
                      ? schemaTypeLabel(traceStep.outputJsonSchemaType)
                      : typeTraceLoading
                        ? '…'
                        : '—';
                  const stepTypeTitle = stepTypeTooltip(traceStep, typeTraceLoading);
                  const isHovered = hoveredStep === index;
                  const plusSlot = index + 1;
                  const isPlusHovered = hoveredPlusSlot === plusSlot;
                  const highlightInput =
                    showTypesMode === 'input-and-output' &&
                    ((index === 0 && sourceValidationError) || (index > 0 && stepValidationError(index - 1)));
                  const highlightOutput = showTypesMode === 'input-and-output' && stepValidationError(index);

                  return (
                    <Fragment key={index}>
                      <NodeWrapper label={`Step ${index + 1}`}>
                        <Box
                          style={{ position: 'relative' }}
                          onMouseEnter={() => setHoveredStep(index)}
                          onMouseLeave={() => setHoveredStep(null)}
                        >
                          <Paper
                            withBorder
                            p="xs"
                            radius="sm"
                            style={{
                              width: 'fit-content',
                              minHeight: BUBBLE_MIN_HEIGHT,
                              display: 'flex',
                              alignItems: 'center',
                              cursor: 'pointer',
                              borderWidth: 1,
                              borderStyle: 'solid',
                              borderColor:
                                editIndex === index
                                  ? 'var(--mantine-color-blue-6)'
                                  : isHovered
                                    ? 'var(--mantine-color-blue-2)'
                                    : 'var(--mantine-color-default-border)',
                            }}
                            title={stepError ?? (stepTypeTitle || 'Click to edit')}
                            onClick={() => setEditIndex(index)}
                            role="button"
                          >
                            <Stack gap={2} align="center">
                              <Text size="xs" fw={600} lineClamp={1}>
                                {stepLabel}
                              </Text>
                              {stepError != null
                                ? (showTypesMode === 'output' || showTypesMode === 'input-and-output') &&
                                  (showTypesMode === 'input-and-output' ? (
                                    <Group gap={4} mt={4} wrap="nowrap" justify="center">
                                      <Badge size="xs" variant="light" color={highlightInput ? 'yellow' : 'gray'}>
                                        {stepInputLabel}
                                      </Badge>
                                      <ArrowRight size={12} color="var(--mantine-color-dimmed)" />
                                      <Badge size="xs" variant="light" color="red">
                                        Error
                                      </Badge>
                                    </Group>
                                  ) : (
                                    <Badge size="xs" variant="light" color="red" mt={4}>
                                      Error
                                    </Badge>
                                  ))
                                : (showTypesMode === 'output' || showTypesMode === 'input-and-output') &&
                                  (showTypesMode === 'input-and-output' ? (
                                    <Group gap={4} mt={4} wrap="nowrap" justify="center">
                                      <Badge size="xs" variant="light" color={highlightInput ? 'yellow' : 'gray'}>
                                        {stepInputLabel}
                                      </Badge>
                                      <ArrowRight size={12} color="var(--mantine-color-dimmed)" />
                                      <Badge size="xs" variant="light" color={highlightOutput ? 'yellow' : 'gray'}>
                                        {stepOutputLabel}
                                      </Badge>
                                    </Group>
                                  ) : (
                                    <Badge size="xs" variant="light" color="gray" mt={4}>
                                      {stepOutputLabel}
                                    </Badge>
                                  ))}
                            </Stack>
                          </Paper>
                          {isHovered && (
                            <Group
                              gap={4}
                              wrap="nowrap"
                              style={{
                                position: 'absolute',
                                top: 2,
                                right: 2,
                                backgroundColor: 'rgba(255, 255, 255, 0.85)',
                                borderRadius: 4,
                                padding: 2,
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <ActionIcon
                                size="xs"
                                variant="subtle"
                                color="red"
                                title="Remove"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  removeAt(index);
                                }}
                              >
                                <X size={12} />
                              </ActionIcon>
                            </Group>
                          )}
                        </Box>
                      </NodeWrapper>
                      <ArrowWrapper
                        validationError={stepValidationError(index)}
                        isPlusHovered={isPlusHovered}
                        onInsert={() => insertAt(plusSlot)}
                        onMouseEnter={() => setHoveredPlusSlot(plusSlot)}
                        onMouseLeave={() => setHoveredPlusSlot(null)}
                      />
                    </Fragment>
                  );
                })}

                <NodeWrapper label="Destination">
                  <Paper
                    withBorder
                    p="xs"
                    radius="sm"
                    style={{
                      width: 'fit-content',
                      minWidth: 120,
                      minHeight: BUBBLE_MIN_HEIGHT,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      ...sourceDestBorderStyle,
                    }}
                  >
                    <Stack gap={2} align="center">
                      <Text size="xs" fw={600} lineClamp={1} title={destLabel}>
                        {destLabel}
                      </Text>
                      {(showTypesMode === 'output' || showTypesMode === 'input-and-output') && (
                        <Badge
                          size="xs"
                          variant="light"
                          color={
                            showTypesMode === 'input-and-output' &&
                            (stepValidationError(currentConfigs.length - 1) ||
                              (currentConfigs.length === 0 && sourceValidationError))
                              ? 'yellow'
                              : 'gray'
                          }
                        >
                          {destTypeLabel}
                        </Badge>
                      )}
                    </Stack>
                  </Paper>
                </NodeWrapper>
              </Flex>
            </Flex>
          </ScrollArea>

          {/* Edit form: add first, edit step, or placeholder. Padding reserves space to reduce layout jump. */}
          <Flex justify="center" mt="md">
            <Paper
              withBorder={!(currentConfigs.length > 0 && (editIndex == null || currentConfigs[editIndex] == null))}
              p="sm"
              radius="md"
              py="md"
              style={{ maxWidth: 400, width: '100%', minHeight: 120 }}
            >
              {currentConfigs.length === 0 ? (
                <>
                  <Text size="xs" c="dimmed" fw={500} mb={4}>
                    Add first transformer
                  </Text>
                  <Select
                    size="xs"
                    label="Type"
                    placeholder="Select type"
                    data={transformerSelectData}
                    value={null}
                    onChange={(value) => value && addFirstTransformer(value)}
                  />
                </>
              ) : editIndex != null && currentConfigs[editIndex] != null ? (
                <>
                  <Flex justify="space-between" align="center" mb={4}>
                    <Text size="xs" c="dimmed" fw={500}>
                      Edit step {editIndex + 1}
                    </Text>
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="gray"
                      title="Deselect / close form"
                      onClick={() => setEditIndex(null)}
                    >
                      <X size={14} />
                    </ActionIcon>
                  </Flex>
                  <TransformerStepFormGeneric
                    allMetadata={transformerMetadata ?? []}
                    config={currentConfigs[editIndex]}
                    onChange={(c) => updateAt(editIndex!, c)}
                    allFolders={allFolders}
                  />
                </>
              ) : (
                <Box pt="sm" pb="sm">
                  <Text size="sm" c="dimmed" ta="center">
                    Select a transformer to edit its options.
                  </Text>
                </Box>
              )}
            </Paper>
          </Flex>
        </Stack>
      </ModalWrapper>

      {/* Admin-only: submodal with raw validation result */}
      <Modal
        opened={opened && validationResultModalOpen}
        onClose={() => setValidationResultModalOpen(false)}
        title="Validation result"
        size="md"
      >
        <Stack gap="sm">
          {typeTraceLoading ? (
            <Text size="sm" c="dimmed">
              Loading…
            </Text>
          ) : lastValidationResult == null ? (
            <Text size="sm" c="dimmed">
              No result yet. Validation runs when the modal opens; if it failed, users can still create transforms and
              syncs.
            </Text>
          ) : (
            <Box
              style={{
                border: '1px solid var(--mantine-color-default-border)',
                borderRadius: 'var(--mantine-radius-md)',
                overflow: 'hidden',
              }}
            >
              <CodeMirror
                value={JSON.stringify(lastValidationResult, null, 2)}
                extensions={[json(), EditorView.lineWrapping]}
                theme={colorScheme === 'dark' ? 'dark' : 'light'}
                readOnly
                basicSetup={{
                  lineNumbers: true,
                  foldGutter: true,
                  highlightActiveLine: false,
                }}
                style={{ fontSize: '12px' }}
              />
            </Box>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={() => setValidationResultModalOpen(false)}>
              Close
            </Button>
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
