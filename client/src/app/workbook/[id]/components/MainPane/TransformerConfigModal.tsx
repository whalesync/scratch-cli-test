'use client';

import { ConnectorIcon } from '@/app/components/Icons/ConnectorIcon';
import { useDevTools } from '@/hooks/use-dev-tools';
import { DocsUrls } from '@/utils/docs-urls';
import type { ComboboxItem } from '@mantine/core';
import {
  ActionIcon,
  Anchor,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import type {
  AutoConvertOptions,
  DataFolder,
  DataFolderId,
  EnsureTypeOptions,
  JSONPathArrayHandling,
  SourceAssetToDestAssetOptions,
  SourceFkToDestFkOptions,
  TransformerConfig,
  TransformerType,
} from '@spinner/shared-types';
import { TRANSFORMER_TYPES, TransformerTypes } from '@spinner/shared-types';
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

interface TransformerConfigModalProps {
  opened: boolean;
  onClose: () => void;
  currentConfigs: TransformerConfig[];
  onSave: (configs: TransformerConfig[]) => void;
  allFolders: DataFolder[];
}

const TRANSFORMER_OPTIONS = TRANSFORMER_TYPES.map((t) => ({ value: t.type, label: t.label, devOnly: t.devOnly }));

const ON_UNRESOLVED_OPTIONS: { value: NonNullable<SourceFkToDestFkOptions['onUnresolved']>; label: string }[] = [
  { value: 'fail', label: 'Stop and fail the sync' },
  { value: 'ignore', label: 'Ignore missing record and sync the rest' },
];

/** Internal per-step form state */
interface StepState {
  id: number;
  type: TransformerType | '';
  stripCurrency: boolean;
  parseInteger: boolean;
  referencedDataFolderId: DataFolderId | '';
  referencedFieldPath: string;
  targetType: AutoConvertOptions['targetType'];
  onUnresolved: NonNullable<SourceFkToDestFkOptions['onUnresolved']>;
  outputType: NonNullable<SourceFkToDestFkOptions['outputType']>;
  expression: string;
  arrayHandling: JSONPathArrayHandling;
  sourceDataFolderId: DataFolderId | '';
  destinationDataFolderId: DataFolderId | '';
  assetOnUnresolved: NonNullable<SourceAssetToDestAssetOptions['onUnresolved']>;
  assetOutputType: NonNullable<SourceAssetToDestAssetOptions['outputType']>;
  expectedType: EnsureTypeOptions['expectedType'];
  onFailure: EnsureTypeOptions['onFailure'];
  fallbackValue: string;
}

let stepIdCounter = 0;

function configToStepState(config: TransformerConfig): StepState {
  return {
    id: ++stepIdCounter,
    type: config.type,
    stripCurrency: config.type === TransformerTypes.StringToNumber ? (config.options?.stripCurrency ?? false) : false,
    parseInteger: config.type === TransformerTypes.StringToNumber ? (config.options?.parseInteger ?? false) : false,
    referencedDataFolderId:
      config.type === TransformerTypes.SourceFkToDestFk || config.type === TransformerTypes.LookupField
        ? config.options.referencedDataFolderId
        : ('' as DataFolderId | ''),
    referencedFieldPath: config.type === TransformerTypes.LookupField ? config.options.referencedFieldPath : '',
    targetType: config.type === TransformerTypes.AutoConvert ? config.options.targetType : 'string',
    onUnresolved: config.type === TransformerTypes.SourceFkToDestFk ? (config.options.onUnresolved ?? 'fail') : 'fail',
    outputType: config.type === TransformerTypes.SourceFkToDestFk ? (config.options.outputType ?? 'array') : 'array',
    expression: config.type === TransformerTypes.JSONPath ? config.options.expression : '',
    arrayHandling: config.type === TransformerTypes.JSONPath ? (config.options.arrayHandling ?? 'first') : 'first',
    sourceDataFolderId:
      config.type === TransformerTypes.SourceAssetToDestAsset
        ? config.options.sourceDataFolderId
        : ('' as DataFolderId | ''),
    destinationDataFolderId:
      config.type === TransformerTypes.SourceAssetToDestAsset
        ? config.options.destinationDataFolderId
        : ('' as DataFolderId | ''),
    assetOnUnresolved:
      config.type === TransformerTypes.SourceAssetToDestAsset ? (config.options.onUnresolved ?? 'fail') : 'fail',
    assetOutputType:
      config.type === TransformerTypes.SourceAssetToDestAsset ? (config.options.outputType ?? 'array') : 'array',
    expectedType: config.type === TransformerTypes.EnsureType ? config.options.expectedType : 'string',
    onFailure: config.type === TransformerTypes.EnsureType ? config.options.onFailure : 'error',
    fallbackValue: config.type === TransformerTypes.EnsureType ? String(config.options.fallbackValue ?? '') : '',
  };
}

function createEmptyStep(): StepState {
  return {
    id: ++stepIdCounter,
    type: '',
    stripCurrency: false,
    parseInteger: false,
    referencedDataFolderId: '' as DataFolderId | '',
    referencedFieldPath: '',
    targetType: 'string',
    onUnresolved: 'fail',
    outputType: 'array',
    expression: '',
    arrayHandling: 'first',
    sourceDataFolderId: '' as DataFolderId | '',
    destinationDataFolderId: '' as DataFolderId | '',
    assetOnUnresolved: 'fail',
    assetOutputType: 'array',
    expectedType: 'string',
    onFailure: 'error',
    fallbackValue: '',
  };
}

function stepStateToConfig(step: StepState): TransformerConfig | null {
  if (!step.type) return null;
  switch (step.type) {
    case TransformerTypes.AutoConvert:
      return { type: step.type, options: { targetType: step.targetType } };
    case TransformerTypes.StringToNumber:
      return { type: step.type, options: { stripCurrency: step.stripCurrency, parseInteger: step.parseInteger } };
    case TransformerTypes.SourceFkToDestFk:
      return {
        type: step.type,
        options: {
          referencedDataFolderId: step.referencedDataFolderId as DataFolderId,
          ...(step.onUnresolved !== 'fail' ? { onUnresolved: step.onUnresolved } : {}),
          ...(step.outputType !== 'array' ? { outputType: step.outputType } : {}),
        },
      };
    case TransformerTypes.LookupField:
      return {
        type: step.type,
        options: {
          referencedDataFolderId: step.referencedDataFolderId as DataFolderId,
          referencedFieldPath: step.referencedFieldPath,
        },
      };
    case TransformerTypes.JSONPath:
      return {
        type: step.type,
        options: {
          expression: step.expression,
          ...(step.arrayHandling !== 'first' ? { arrayHandling: step.arrayHandling } : {}),
        },
      };
    case TransformerTypes.SourceAssetToDestAsset:
      return {
        type: step.type,
        options: {
          sourceDataFolderId: step.sourceDataFolderId as DataFolderId,
          destinationDataFolderId: step.destinationDataFolderId as DataFolderId,
          ...(step.assetOnUnresolved !== 'fail' ? { onUnresolved: step.assetOnUnresolved } : {}),
          ...(step.assetOutputType !== 'array' ? { outputType: step.assetOutputType } : {}),
        },
      };
    case TransformerTypes.EnsureType:
      return {
        type: step.type,
        options: {
          expectedType: step.expectedType,
          onFailure: step.onFailure,
          ...(step.onFailure === 'other' ? { fallbackValue: step.fallbackValue } : {}),
        },
      };
    default:
      return { type: step.type } as TransformerConfig;
  }
}

function isStepValid(step: StepState): boolean {
  if (!step.type) return false;
  if (step.type === TransformerTypes.SourceFkToDestFk && !step.referencedDataFolderId) return false;
  if (step.type === TransformerTypes.LookupField && (!step.referencedDataFolderId || !step.referencedFieldPath))
    return false;
  if (step.type === TransformerTypes.JSONPath && !step.expression.trim()) return false;
  if (
    step.type === TransformerTypes.SourceAssetToDestAsset &&
    (!step.sourceDataFolderId || !step.destinationDataFolderId)
  )
    return false;
  return true;
}

export function TransformerConfigModal({
  opened,
  onClose,
  currentConfigs,
  onSave,
  allFolders,
}: TransformerConfigModalProps) {
  const { isDevToolsEnabled } = useDevTools();
  const [steps, setSteps] = useState<StepState[]>([]);

  const transformerOptions = useMemo(
    () => TRANSFORMER_OPTIONS.filter((opt) => !opt.devOnly || isDevToolsEnabled),
    [isDevToolsEnabled],
  );

  // Sync form state whenever the modal opens
  useEffect(() => {
    if (opened) {
      if (currentConfigs.length > 0) {
        setSteps(currentConfigs.map(configToStepState));
      } else {
        setSteps([createEmptyStep()]);
      }
    }
  }, [opened, currentConfigs]);

  const updateStep = (index: number, changes: Partial<StepState>) => {
    setSteps((prev) => prev.map((s, i) => (i === index ? { ...s, ...changes } : s)));
  };

  const removeStep = (index: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== index));
  };

  const addStep = () => {
    setSteps((prev) => [...prev, createEmptyStep()]);
  };

  const handleSave = () => {
    const configs = steps.map(stepStateToConfig).filter((c): c is TransformerConfig => c !== null);
    onSave(configs);
    onClose();
  };

  const nonEmptySteps = steps.filter((s) => s.type !== '');
  const isSaveDisabled = nonEmptySteps.length > 0 && nonEmptySteps.some((s) => !isStepValid(s));

  const folderSelectData = allFolders.map((f) => ({
    value: f.id,
    label: f.name,
    connectorService: f.connectorService,
  }));

  const assetFolderSelectData = allFolders
    .filter((f) => f.isAssetTable)
    .map((f) => ({
      value: f.id,
      label: f.name,
      connectorService: f.connectorService,
    }));

  const renderFolderOption = ({ option }: { option: ComboboxItem & { connectorService?: string | null } }) => (
    <Group gap="xs" wrap="nowrap">
      {option.connectorService && <ConnectorIcon connector={option.connectorService} size={16} p={0} />}
      <Text size="sm">{option.label}</Text>
    </Group>
  );

  return (
    <Modal opened={opened} onClose={onClose} title="Configure Transformers" size="md">
      <Stack gap="md">
        {steps.map((step, index) => (
          <Stack key={step.id} gap="xs">
            {index > 0 && <Divider />}
            <Group gap="xs" justify="space-between">
              <Text size="sm" fw={500} c="dimmed">
                Step {index + 1}
              </Text>
              {steps.length > 1 && (
                <Tooltip label="Remove step">
                  <ActionIcon variant="subtle" color="gray" size="sm" onClick={() => removeStep(index)}>
                    <Trash2 size={14} />
                  </ActionIcon>
                </Tooltip>
              )}
            </Group>

            <Select
              label="Transformer Type"
              placeholder="None"
              data={transformerOptions}
              value={step.type || null}
              onChange={(val) => updateStep(index, { type: (val as TransformerType) || '' })}
              clearable
            />

            {step.type === TransformerTypes.AutoConvert && (
              <Select
                label="Target Type"
                description="The data type to convert the source value to"
                data={[
                  { value: 'string', label: 'String' },
                  { value: 'number', label: 'Number' },
                  { value: 'integer', label: 'Integer' },
                  { value: 'boolean', label: 'Boolean' },
                  { value: 'array', label: 'Array' },
                ]}
                value={step.targetType}
                onChange={(val) =>
                  updateStep(index, { targetType: (val as AutoConvertOptions['targetType']) || 'string' })
                }
              />
            )}

            {step.type === TransformerTypes.StringToNumber && (
              <Stack gap="xs">
                <Checkbox
                  label="Strip currency symbols ($, €, £, ¥, etc.)"
                  checked={step.stripCurrency}
                  onChange={(e) => updateStep(index, { stripCurrency: e.currentTarget.checked })}
                />
                <Checkbox
                  label="Parse as integer (truncate decimals)"
                  checked={step.parseInteger}
                  onChange={(e) => updateStep(index, { parseInteger: e.currentTarget.checked })}
                />
              </Stack>
            )}

            {step.type === TransformerTypes.SourceFkToDestFk && (
              <>
                <Select
                  label="Referenced Folder"
                  description="The folder containing the records referenced by this foreign key"
                  placeholder="Select folder"
                  data={folderSelectData}
                  value={step.referencedDataFolderId || null}
                  onChange={(val) => updateStep(index, { referencedDataFolderId: (val || '') as DataFolderId | '' })}
                  renderOption={renderFolderOption}
                  searchable
                />
                <Select
                  label="Output type"
                  description="Whether to output multiple values (array) or a single value"
                  data={[
                    { value: 'array', label: 'Multiple values (array)' },
                    { value: 'single', label: 'Single value (first item)' },
                  ]}
                  value={step.outputType}
                  onChange={(val) =>
                    updateStep(index, {
                      outputType: (val as SourceFkToDestFkOptions['outputType']) || 'array',
                    })
                  }
                />
                <Select
                  label="When a referenced record cannot be found"
                  data={ON_UNRESOLVED_OPTIONS}
                  value={step.onUnresolved}
                  onChange={(val) =>
                    updateStep(index, {
                      onUnresolved: (val as SourceFkToDestFkOptions['onUnresolved']) || 'fail',
                    })
                  }
                />
              </>
            )}

            {step.type === TransformerTypes.LookupField && (
              <>
                <Select
                  label="Referenced Folder"
                  description="The folder containing the records referenced by this foreign key"
                  placeholder="Select folder"
                  data={folderSelectData}
                  value={step.referencedDataFolderId || null}
                  onChange={(val) => updateStep(index, { referencedDataFolderId: (val || '') as DataFolderId | '' })}
                  renderOption={renderFolderOption}
                  searchable
                />
                <TextInput
                  label="Field Path"
                  description="The field to extract from the referenced record (e.g. 'name' or 'company.displayName')"
                  placeholder="e.g. name"
                  value={step.referencedFieldPath}
                  onChange={(e) => updateStep(index, { referencedFieldPath: e.currentTarget.value })}
                />
              </>
            )}

            {step.type === TransformerTypes.JSONPath && (
              <>
                <TextInput
                  label="JSONPath Expression"
                  description="JSONPath expression (e.g. $.store.book[0].title)"
                  placeholder="$.path.to.value"
                  value={step.expression}
                  onChange={(e) => updateStep(index, { expression: e.currentTarget.value })}
                />
                <Select
                  label="Multiple results"
                  description="How to handle when the expression matches multiple values"
                  data={[
                    { value: 'first', label: 'First value' },
                    { value: 'array', label: 'Array' },
                    { value: 'concat', label: 'Concatenate' },
                    { value: 'join_space', label: 'Join with spaces' },
                    { value: 'join_comma', label: 'Join with commas' },
                  ]}
                  value={step.arrayHandling}
                  onChange={(val) => updateStep(index, { arrayHandling: (val as JSONPathArrayHandling) || 'first' })}
                />
              </>
            )}

            {step.type === TransformerTypes.EnsureType && (
              <>
                <Select
                  label="Expected Type"
                  description="The runtime type the value must match"
                  data={[
                    { value: 'string', label: 'String' },
                    { value: 'number', label: 'Number' },
                    { value: 'boolean', label: 'Boolean' },
                    { value: 'object', label: 'Object' },
                    { value: 'array', label: 'Array' },
                  ]}
                  value={step.expectedType}
                  onChange={(val) =>
                    updateStep(index, { expectedType: (val as EnsureTypeOptions['expectedType']) || 'string' })
                  }
                />
                <Select
                  label="When validation fails"
                  description="Action to take if the value does not match the expected type"
                  data={[
                    { value: 'error', label: 'Throw error' },
                    { value: 'null', label: 'Return null' },
                    { value: 'omit', label: 'Omit field' },
                    { value: 'other', label: 'Use fallback value' },
                  ]}
                  value={step.onFailure}
                  onChange={(val) =>
                    updateStep(index, { onFailure: (val as EnsureTypeOptions['onFailure']) || 'error' })
                  }
                />
                {step.onFailure === 'other' && (
                  <TextInput
                    label="Fallback Value"
                    description="Value to use when validation fails (saved as string)"
                    placeholder="e.g. 0, unknown, etc."
                    value={step.fallbackValue}
                    onChange={(e) => updateStep(index, { fallbackValue: e.currentTarget.value })}
                  />
                )}
              </>
            )}

            {step.type === TransformerTypes.SourceAssetToDestAsset && (
              <>
                <Select
                  label="Source Asset Folder"
                  description="The asset folder on the source side containing the referenced files"
                  placeholder="Select asset folder"
                  data={assetFolderSelectData}
                  value={step.sourceDataFolderId || null}
                  onChange={(val) => updateStep(index, { sourceDataFolderId: (val || '') as DataFolderId | '' })}
                  renderOption={renderFolderOption}
                  searchable
                />
                <Select
                  label="Destination Asset Folder"
                  description="The asset folder on the destination side where assets will be created"
                  placeholder="Select asset folder"
                  data={assetFolderSelectData}
                  value={step.destinationDataFolderId || null}
                  onChange={(val) => updateStep(index, { destinationDataFolderId: (val || '') as DataFolderId | '' })}
                  renderOption={renderFolderOption}
                  searchable
                />
                <Select
                  label="Output type"
                  description="Whether to output multiple values (array) or a single value"
                  data={[
                    { value: 'array', label: 'Multiple values (array)' },
                    { value: 'single', label: 'Single value (first item)' },
                  ]}
                  value={step.assetOutputType}
                  onChange={(val) =>
                    updateStep(index, {
                      assetOutputType: (val as SourceAssetToDestAssetOptions['outputType']) || 'array',
                    })
                  }
                />
                <Select
                  label="When a source asset cannot be found"
                  data={ON_UNRESOLVED_OPTIONS}
                  value={step.assetOnUnresolved}
                  onChange={(val) =>
                    updateStep(index, {
                      assetOnUnresolved: (val as SourceAssetToDestAssetOptions['onUnresolved']) || 'fail',
                    })
                  }
                />
              </>
            )}
          </Stack>
        ))}

        <Group gap="xs">
          <Button variant="subtle" color="gray" size="xs" leftSection={<Plus size={14} />} onClick={addStep}>
            Add transformer step
          </Button>
          <Anchor href={DocsUrls.transformerPipeline} target="_blank" size="xs">
            How does this work?
          </Anchor>
        </Group>

        <Group justify="flex-end" mt="md">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isSaveDisabled}>
            Save
          </Button>
        </Group>
      </Stack>
    </Modal>
  );
}
