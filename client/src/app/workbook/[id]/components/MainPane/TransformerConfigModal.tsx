'use client';

import { ModalWrapper } from '@/app/components/ModalWrapper';
import { syncApi } from '@/lib/api/sync';
import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import type {
  DataFolder,
  DataFolderId,
  MappingTypeTraceResponse,
  TransformerConfig,
  WorkbookId,
} from '@spinner/shared-types';
import { getTransformerLabel, TRANSFORMER_TYPES, TransformerTypes, type TransformerType } from '@spinner/shared-types';
import { ArrowRight, Code, Plus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

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

/** Default config for a new step (used when inserting or when switching type). */
function defaultConfigForType(type: TransformerType): TransformerConfig {
  switch (type) {
    case TransformerTypes.AutoConvert:
      return { type: TransformerTypes.AutoConvert, options: { targetType: 'string' } };
    case TransformerTypes.ArrayAutoConvert:
      return { type: TransformerTypes.ArrayAutoConvert, options: { targetType: 'string' } };
    case TransformerTypes.StringToNumber:
      return { type: TransformerTypes.StringToNumber, options: {} };
    case TransformerTypes.SourceFkToDestFk:
      return {
        type: TransformerTypes.SourceFkToDestFk,
        options: { referencedDataFolderId: '' as DataFolderId },
      };
    case TransformerTypes.LookupField:
      return {
        type: TransformerTypes.LookupField,
        options: { referencedDataFolderId: '' as DataFolderId, referencedFieldPath: '' },
      };
    case TransformerTypes.JSONPath:
      return { type: TransformerTypes.JSONPath, options: { expression: '' } };
    case TransformerTypes.SourceAssetToDestAsset:
      return {
        type: TransformerTypes.SourceAssetToDestAsset,
        options: { sourceDataFolderId: '' as DataFolderId, destinationDataFolderId: '' as DataFolderId },
      };
    case TransformerTypes.EnsureType:
      return {
        type: TransformerTypes.EnsureType,
        options: { expectedType: 'string', onFailure: 'null' },
      };
    case TransformerTypes.NotionToHtml:
    case TransformerTypes.AirmarkToHtml:
    case TransformerTypes.HtmlToAirmark:
    case TransformerTypes.WebflowOption:
    case TransformerTypes.WebflowOptionIdToValue:
    case TransformerTypes.Slugify:
    case TransformerTypes.NotionFileUrl:
      return { type, options: {} };
    default:
      return { type: TransformerTypes.AutoConvert, options: { targetType: 'string' } };
  }
}

const transformerSelectData = TRANSFORMER_TYPES.map((t) => ({ value: t.type, label: t.label }));

const sourceDestBorderStyle = { borderColor: 'var(--mantine-color-gray-8)' };

/** Single edit form for one transformer step (max-width 200px). */
function TransformerStepForm({
  config,
  onChange,
  allFolders,
}: {
  config: TransformerConfig;
  onChange: (c: TransformerConfig) => void;
  allFolders: DataFolder[];
}) {
  const folderOptions = allFolders.map((f) => ({ value: f.id, label: f.name ?? f.id }));

  const updateOptions = useCallback(
    (opts: Record<string, unknown>) => {
      onChange({ ...config, options: opts } as TransformerConfig);
    },
    [config, onChange],
  );

  return (
    <Stack gap="xs" style={{ maxWidth: 200 }}>
      <Select
        size="xs"
        label="Type"
        data={transformerSelectData}
        value={config.type}
        onChange={(value) => value && onChange(defaultConfigForType(value as TransformerType))}
      />
      {config.type === TransformerTypes.EnsureType && config.options && (
        <>
          <Select
            size="xs"
            label="Expected type"
            data={[
              { value: 'string', label: 'string' },
              { value: 'number', label: 'number' },
              { value: 'boolean', label: 'boolean' },
              { value: 'object', label: 'object' },
              { value: 'array', label: 'array' },
            ]}
            value={config.options.expectedType}
            onChange={(v) => v && updateOptions({ ...config.options, expectedType: v })}
          />
          <Select
            size="xs"
            label="On failure"
            data={[
              { value: 'null', label: 'null' },
              { value: 'error', label: 'error' },
              { value: 'omit', label: 'omit' },
              { value: 'other', label: 'other' },
            ]}
            value={config.options.onFailure}
            onChange={(v) => v && updateOptions({ ...config.options, onFailure: v })}
          />
        </>
      )}
      {config.type === TransformerTypes.StringToNumber && (
        <Stack gap={4}>
          <Checkbox
            size="xs"
            label="Strip currency"
            checked={config.options?.stripCurrency ?? false}
            onChange={(e) => updateOptions({ ...config.options, stripCurrency: e.currentTarget.checked })}
          />
          <Checkbox
            size="xs"
            label="Parse integer"
            checked={config.options?.parseInteger ?? false}
            onChange={(e) => updateOptions({ ...config.options, parseInteger: e.currentTarget.checked })}
          />
        </Stack>
      )}
      {config.type === TransformerTypes.AutoConvert && config.options && (
        <Select
          size="xs"
          label="Target type"
          data={[
            { value: 'string', label: 'string' },
            { value: 'number', label: 'number' },
            { value: 'integer', label: 'integer' },
            { value: 'boolean', label: 'boolean' },
            { value: 'array', label: 'array' },
          ]}
          value={config.options.targetType}
          onChange={(v) => v && updateOptions({ ...config.options, targetType: v })}
        />
      )}
      {config.type === TransformerTypes.JSONPath && config.options && (
        <TextInput
          size="xs"
          label="Expression"
          placeholder="$..."
          value={config.options.expression ?? ''}
          onChange={(e) => updateOptions({ ...config.options, expression: e.currentTarget.value })}
        />
      )}
      {config.type === TransformerTypes.SourceFkToDestFk && config.options && (
        <Select
          size="xs"
          label="Referenced folder"
          data={folderOptions}
          value={config.options.referencedDataFolderId ?? ''}
          onChange={(v) => v && updateOptions({ ...config.options, referencedDataFolderId: v })}
        />
      )}
      {config.type === TransformerTypes.LookupField && config.options && (
        <>
          <Select
            size="xs"
            label="Referenced folder"
            data={folderOptions}
            value={config.options.referencedDataFolderId ?? ''}
            onChange={(v) => v && updateOptions({ ...config.options, referencedDataFolderId: v })}
          />
          <TextInput
            size="xs"
            label="Field path"
            placeholder="e.g. name"
            value={config.options.referencedFieldPath ?? ''}
            onChange={(e) => updateOptions({ ...config.options, referencedFieldPath: e.currentTarget.value })}
          />
        </>
      )}
    </Stack>
  );
}

export function TransformerConfigModal({
  opened,
  onClose,
  currentConfigs,
  onSave,
  allFolders,
  mappingContext,
}: TransformerConfigModalProps) {
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
      next.splice(index, 0, defaultConfigForType(TransformerTypes.AutoConvert));
      onSave(next);
      setEditIndex(index);
    },
    [currentConfigs, onSave],
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
    (type: TransformerType) => {
      onSave([defaultConfigForType(type)]);
      setEditIndex(0);
    },
    [onSave],
  );

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
        size="xl"
        customProps={{
          footer: (
            <Button variant="default" onClick={onClose}>
              Close
            </Button>
          ),
        }}
      >
        <Stack gap="md">
          {/* Horizontal flow: Step 1/2/… row, then Source → [arrow+plus] step … → Destination */}
          <ScrollArea.Autosize type="scroll" scrollbarSize={8} mah={160}>
            <Stack gap="xs" style={{ minWidth: 'min-content' }}>
              {/* First row: step labels above each transformer bubble */}
              <Flex align="center" justify="center" gap="xs" wrap="nowrap">
                <Box style={{ minWidth: 100, flexShrink: 0 }} />
                {currentConfigs.map((_, index) => (
                  <Flex key={index} align="center" gap="xs">
                    <Box style={{ flexShrink: 0, width: 24 }} />
                    <Text size="xs" c="dimmed" style={{ minWidth: 100, textAlign: 'center' }}>
                      Step {index + 1}
                    </Text>
                  </Flex>
                ))}
                <Box style={{ flexShrink: 0, width: 24 }} />
                <Box style={{ minWidth: 100, flexShrink: 0 }} />
              </Flex>
              {/* Second row: bubbles and arrows */}
              <Flex align="center" justify="center" gap="xs" wrap="nowrap" style={{ minWidth: 'min-content' }}>
                <Paper withBorder p="xs" radius="sm" style={{ minWidth: 100, flexShrink: 0, ...sourceDestBorderStyle }}>
                  <Stack gap={2}>
                    <Text size="xs" lineClamp={1}>
                      Source
                    </Text>
                    <Text size="xs" lineClamp={1} title={sourceLabel}>
                      {sourceLabel}
                    </Text>
                    <Badge size="xs" variant="light" color="gray">
                      {sourceTypeLabel}
                    </Badge>
                  </Stack>
                </Paper>

                {currentConfigs.map((config, index) => {
                  const traceStep = traceSteps[index];
                  const stepLabel = traceStep ? traceStep.transformerName : getTransformerLabel(config.type);
                  const stepError = traceStep?.error;
                  const stepTypeLabel =
                    traceStep?.type != null ? schemaTypeLabel(traceStep.type) : typeTraceLoading ? '…' : '—';
                  const isHovered = hoveredStep === index;

                  const plusSlot = index;
                  const isPlusHovered = hoveredPlusSlot === plusSlot;

                  return (
                    <Flex key={index} align="center" gap="xs">
                      {/* Arrow with plus underneath: insert at this index */}
                      <Stack
                        align="center"
                        gap={2}
                        style={{ flexShrink: 0 }}
                        onMouseEnter={() => setHoveredPlusSlot(plusSlot)}
                        onMouseLeave={() => setHoveredPlusSlot(null)}
                      >
                        <ArrowRight size={16} color="var(--mantine-color-dimmed)" />
                        <ActionIcon
                          size="xs"
                          variant={isPlusHovered ? 'light' : 'subtle'}
                          color={isPlusHovered ? 'blue' : 'gray'}
                          title="Add transform"
                          onClick={() => insertAt(index)}
                        >
                          <Plus size={12} />
                        </ActionIcon>
                      </Stack>
                      {/* Step bubble: whole bubble clickable to edit; hover shows floating remove (no layout shift) */}
                      <Stack gap={2} align="center">
                        <Box
                          style={{ position: 'relative', flexShrink: 0 }}
                          onMouseEnter={() => setHoveredStep(index)}
                          onMouseLeave={() => setHoveredStep(null)}
                        >
                          <Paper
                            withBorder
                            p="xs"
                            radius="sm"
                            style={{
                              minWidth: 100,
                              cursor: 'pointer',
                              // Fixed 1px border so selected/hover don't shift layout
                              borderWidth: 1,
                              borderStyle: 'solid',
                              borderColor:
                                editIndex === index
                                  ? 'var(--mantine-color-blue-6)'
                                  : isHovered
                                    ? 'var(--mantine-color-blue-2)'
                                    : 'var(--mantine-color-default-border)',
                            }}
                            title={
                              stepError ?? ((traceStep?.type ? schemaTypeLabel(traceStep.type) : '') || 'Click to edit')
                            }
                            onClick={() => setEditIndex(index)}
                            role="button"
                          >
                            <Text size="xs" lineClamp={1}>
                              {stepLabel}
                            </Text>
                            {stepError != null ? (
                              <Badge size="xs" variant="light" color="red" mt={4}>
                                Error
                              </Badge>
                            ) : (
                              <Badge size="xs" variant="light" color="gray" mt={4}>
                                {stepTypeLabel}
                              </Badge>
                            )}
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
                      </Stack>
                    </Flex>
                  );
                })}

                {/* Arrow + plus after last step: insert at end */}
                <Stack
                  align="center"
                  gap={2}
                  style={{ flexShrink: 0 }}
                  onMouseEnter={() => setHoveredPlusSlot(currentConfigs.length)}
                  onMouseLeave={() => setHoveredPlusSlot(null)}
                >
                  <ArrowRight size={16} color="var(--mantine-color-dimmed)" />
                  <ActionIcon
                    size="xs"
                    variant={hoveredPlusSlot === currentConfigs.length ? 'light' : 'subtle'}
                    color={hoveredPlusSlot === currentConfigs.length ? 'blue' : 'gray'}
                    title="Add transform"
                    onClick={() => insertAt(currentConfigs.length)}
                  >
                    <Plus size={12} />
                  </ActionIcon>
                </Stack>

                <Paper withBorder p="xs" radius="sm" style={{ minWidth: 100, flexShrink: 0, ...sourceDestBorderStyle }}>
                  <Stack gap={2}>
                    <Text size="xs" lineClamp={1}>
                      Destination
                    </Text>
                    <Text size="xs" lineClamp={1} title={destLabel}>
                      {destLabel}
                    </Text>
                    <Badge size="xs" variant="light" color="gray">
                      {destTypeLabel}
                    </Badge>
                  </Stack>
                </Paper>
              </Flex>
            </Stack>
          </ScrollArea.Autosize>

          {/* Edit form: when no configs always show type-only "add first"; when configs exist show form for editIndex */}
          {(currentConfigs.length === 0 || (editIndex != null && currentConfigs[editIndex] != null)) && (
            <Flex justify="center">
              <Paper withBorder p="sm" radius="md" style={{ maxWidth: 200, width: '100%' }}>
                {currentConfigs.length === 0 ? (
                  <>
                    <Text size="xs" c="dimmed" fw={500} mb="xs">
                      Add first transformer
                    </Text>
                    <Select
                      size="xs"
                      label="Type"
                      placeholder="Select type"
                      data={transformerSelectData}
                      value={null}
                      onChange={(value) => value && addFirstTransformer(value as TransformerType)}
                    />
                  </>
                ) : (
                  <>
                    <Text size="xs" c="dimmed" fw={500} mb="xs">
                      Edit step {editIndex! + 1}
                    </Text>
                    <TransformerStepForm
                      config={currentConfigs[editIndex!]}
                      onChange={(c) => updateAt(editIndex!, c)}
                      allFolders={allFolders}
                    />
                  </>
                )}
              </Paper>
            </Flex>
          )}
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
            <ScrollArea.Autosize mah={400} type="auto">
              <Paper withBorder p="sm" style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>
                {JSON.stringify(lastValidationResult, null, 2)}
              </Paper>
            </ScrollArea.Autosize>
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
