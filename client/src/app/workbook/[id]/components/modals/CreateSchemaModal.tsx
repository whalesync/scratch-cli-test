'use client';

import { ButtonDangerLight, ButtonPrimarySolid, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { Text12Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { ConfirmDialog, useConfirmDialog } from '@/app/components/modals/ConfirmDialog';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useCreateDestinations } from '@/hooks/use-create-destinations';
import { useDataFolders } from '@/hooks/use-data-folders';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Checkbox, Divider, Group, Modal, SegmentedControl, Select, Stack, TextInput } from '@mantine/core';
import {
  createSchemaFieldsSchema,
  type CreateSchemaFieldsResponse,
  type CreateSchemaStatus,
  type CreateSchemaTablesResponse,
  type ValidateSchemaResponse,
  type WorkbookId,
} from '@spinner/shared-types';
import { CopyIcon, DatabaseIcon, PlusIcon, RotateCcwIcon } from 'lucide-react';
import { useState } from 'react';
import {
  editorFieldsFromSpecs,
  findDuplicateFieldNameIds,
  fromCreateTablesDto,
  makeEmptyField,
  makeEmptyTable,
  splitRemoteId,
  toCreateFieldsDto,
  toCreateTablesDto,
  zodIssuesToValidateIssues,
  type EditorField,
  type EditorTable,
} from './create-schema-plan';
import { CreateSchemaFieldRow } from './CreateSchemaFieldRow';
import { CreateSchemaResults, type PlanResult } from './CreateSchemaResults';
import { CreateSchemaTableEditor } from './CreateSchemaTableEditor';

type SchemaMode = 'createTables' | 'createFields';
type CreateResult = CreateSchemaTablesResponse | CreateSchemaFieldsResponse;

interface CreateSchemaModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  connectorAccountId: string;
  service: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

/**
 * Admin/dev-only tool (DEV-10407) for hand-building a create-schema plan and
 * driving the create-schema API: build tables + fields, dry-run with /validate,
 * then execute with /tables or /fields. Errors from either are shown in detail.
 */
export function CreateSchemaModal({
  opened,
  onClose,
  workbookId,
  connectorAccountId,
  service,
}: CreateSchemaModalProps) {
  const [mode, setMode] = useState<SchemaMode>('createTables');
  const [tables, setTables] = useState<EditorTable[]>([makeEmptyTable()]);
  const [existingFields, setExistingFields] = useState<EditorField[]>([makeEmptyField()]);
  // Add-fields target: a chosen data folder (preferred) or a free-typed remote id (fallback).
  const [selectedDataFolderId, setSelectedDataFolderId] = useState('');
  const [remoteTableIdText, setRemoteTableIdText] = useState('');
  const [remoteParentId, setRemoteParentId] = useState('');
  const [parentFolderId, setParentFolderId] = useState('');
  const [materializeLocally, setMaterializeLocally] = useState(true);

  const [copySourceFolderId, setCopySourceFolderId] = useState('');
  // Optional add-fields target for "Copy from folder": an existing destination
  // folder to diff against (empty ⇒ create a new table).
  const [copyDestinationDataFolderId, setCopyDestinationDataFolderId] = useState('');

  const [validateResult, setValidateResult] = useState<ValidateSchemaResponse | null>(null);
  const [createResult, setCreateResult] = useState<CreateResult | null>(null);
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [isGeneratingPlan, setIsGeneratingPlan] = useState(false);

  const { open: openConfirm, dialogProps } = useConfirmDialog();

  // The remote parent picker hits the connector, and this modal is mounted for
  // every connector node, so only fetch destinations while it's actually open.
  const { destinations, isLoading: isLoadingDestinations } = useCreateDestinations(
    workbookId,
    connectorAccountId,
    opened && mode === 'createTables',
  );
  const { folders, dataFolderGroups } = useDataFolders(workbookId);
  const connectorFolders = folders.filter((folder) => folder.connectorAccountId === connectorAccountId);
  // Existing tables for this connector, used to prepopulate the add-fields target
  // and the foreign-key "existing remote table" pickers.
  const existingTableOptions = connectorFolders.map((folder) => ({
    value: folder.tableId.join('/'),
    label: `${folder.name} (${folder.tableId.join('/')})`,
  }));
  // All workbook folders for "Copy from folder", grouped by connector for the picker.
  const sourceFolderGroups = dataFolderGroups
    .map((group) => ({
      group: group.name,
      items: group.dataFolders.map((folder) => ({ value: folder.id, label: folder.name })),
    }))
    .filter((group) => group.items.length > 0);

  const allTableRefs = tables.map((table) => ({ value: table.ref, label: table.name.trim() || table.ref }));
  const duplicateExistingFieldNameIds = findDuplicateFieldNameIds(existingFields);

  // The selected data folder's remote table id, or the free-typed fallback.
  const resolveRemoteTableId = (): string[] => {
    const folder = connectorFolders.find((candidate) => candidate.id === selectedDataFolderId);
    return folder ? folder.tableId : splitRemoteId(remoteTableIdText);
  };

  const updateTable = (tableId: string, updates: Partial<EditorTable>) =>
    setTables((current) => current.map((table) => (table.id === tableId ? { ...table, ...updates } : table)));
  const addTable = () => setTables((current) => [...current, makeEmptyTable()]);
  const removeTable = (tableId: string) => setTables((current) => current.filter((table) => table.id !== tableId));

  const updateExistingField = (fieldId: string, updates: Partial<EditorField>) =>
    setExistingFields((current) => current.map((field) => (field.id === fieldId ? { ...field, ...updates } : field)));
  const addExistingField = () => setExistingFields((current) => [...current, makeEmptyField()]);
  const removeExistingField = (fieldId: string) =>
    setExistingFields((current) => current.filter((field) => field.id !== fieldId));

  const clearResults = () => {
    setValidateResult(null);
    setCreateResult(null);
    setPlanResult(null);
    setError(null);
  };

  const doReset = () => {
    setTables([makeEmptyTable()]);
    setExistingFields([makeEmptyField()]);
    setSelectedDataFolderId('');
    setRemoteTableIdText('');
    setRemoteParentId('');
    setParentFolderId('');
    setMaterializeLocally(true);
    setCopySourceFolderId('');
    setCopyDestinationDataFolderId('');
    clearResults();
  };

  // "Copy from folder": run planFromFolder for the chosen source folder against this
  // (destination) connector, then prefill the editor with the generated plan. When an
  // existing destination table is chosen, the plan is an add-fields diff instead of a
  // create-tables plan, so seed the add-fields editor for that table.
  const handleCopyFromFolder = async () => {
    if (!copySourceFolderId) return;
    setIsGeneratingPlan(true);
    clearResults();
    try {
      const response = await scratchApiClient.schema.planFromFolder(workbookId, {
        sources: [
          {
            dataFolderId: copySourceFolderId,
            ...(copyDestinationDataFolderId ? { existingDestinationDataFolderId: copyDestinationDataFolderId } : {}),
          },
        ],
        destinationConnectorAccountId: connectorAccountId,
      });
      setPlanResult({ notes: response.notes, destinationSupportsCreation: response.destinationSupportsCreation });

      const fieldPlan = response.fieldPlans[0];
      if (fieldPlan) {
        // Existing destination table: switch to the add-fields editor, seeded with
        // only the missing fields and targeting the chosen destination folder.
        setMode('createFields');
        setSelectedDataFolderId(fieldPlan.destinationDataFolderId);
        setRemoteTableIdText('');
        setExistingFields(editorFieldsFromSpecs(fieldPlan.fields));
        ScratchpadNotifications.success({
          title: 'Plan generated',
          message: `Prefilled ${fieldPlan.fields.length} missing field${fieldPlan.fields.length === 1 ? '' : 's'} to add to the existing table.`,
        });
        return;
      }

      const seeded = fromCreateTablesDto(response.plan);
      setTables(seeded.tables);
      if (seeded.remoteParentId) setRemoteParentId(seeded.remoteParentId);
      ScratchpadNotifications.success({
        title: 'Plan generated',
        message: `Prefilled ${seeded.tables.length} table${seeded.tables.length === 1 ? '' : 's'} from the source folder.`,
      });
    } catch (err) {
      setError(errorMessage(err));
      ScratchpadNotifications.error({ title: 'Plan generation failed', message: errorMessage(err) });
    } finally {
      setIsGeneratingPlan(false);
    }
  };

  const hasPlanContent =
    mode === 'createTables'
      ? tables.length > 1 ||
        tables.some((table) => table.name.trim() || table.fields.some((field) => field.name.trim()))
      : Boolean(selectedDataFolderId) ||
        Boolean(remoteTableIdText.trim()) ||
        existingFields.some((field) => field.name.trim());

  const handleReset = () => {
    if (!hasPlanContent) {
      doReset();
      return;
    }
    openConfirm({
      title: 'Reset plan',
      message: 'Clear the current plan and start over? This cannot be undone.',
      confirmLabel: 'Reset',
      variant: 'danger',
      onConfirm: async () => doReset(),
    });
  };

  const handleValidate = async () => {
    clearResults();
    if (mode === 'createFields') {
      // The server /validate endpoint only accepts the tables body, so validate
      // the fields plan client-side against the same shared zod schema.
      const body = toCreateFieldsDto({
        connectorAccountId,
        remoteTableId: resolveRemoteTableId(),
        fields: existingFields,
      });
      const parsed = createSchemaFieldsSchema.safeParse(body);
      setValidateResult({
        valid: parsed.success,
        issues: parsed.success ? [] : zodIssuesToValidateIssues(parsed.error.issues),
        schemaCreationSupported: true,
        service,
      });
      return;
    }
    setIsValidating(true);
    try {
      const body = toCreateTablesDto({
        connectorAccountId,
        tables,
        materializeLocally,
        remoteParentId,
        parentFolderId,
      });
      setValidateResult(await scratchApiClient.schema.validate(workbookId, body));
    } catch (err) {
      setError(errorMessage(err));
      ScratchpadNotifications.error({ title: 'Validation failed', message: errorMessage(err) });
    } finally {
      setIsValidating(false);
    }
  };

  const notifyByStatus = (status: CreateSchemaStatus, noun: string) => {
    if (status === 'ok') {
      ScratchpadNotifications.success({ title: 'Success', message: `${noun} created.` });
    } else if (status === 'partial') {
      ScratchpadNotifications.warning({
        title: 'Partial success',
        message: `Some ${noun.toLowerCase()} were not created.`,
      });
    } else {
      ScratchpadNotifications.error({
        title: 'Failed',
        message: `Could not create ${noun.toLowerCase()} (${status}).`,
      });
    }
  };

  const handleCreate = async () => {
    clearResults();
    setIsCreating(true);
    try {
      if (mode === 'createTables') {
        const body = toCreateTablesDto({
          connectorAccountId,
          tables,
          materializeLocally,
          remoteParentId,
          parentFolderId,
        });
        const result = await scratchApiClient.schema.createTables(workbookId, body);
        setCreateResult(result);
        notifyByStatus(result.status, 'Tables');
      } else {
        const body = toCreateFieldsDto({
          connectorAccountId,
          remoteTableId: resolveRemoteTableId(),
          fields: existingFields,
        });
        const result = await scratchApiClient.schema.createFields(workbookId, body);
        setCreateResult(result);
        notifyByStatus(result.status, 'Fields');
      }
    } catch (err) {
      setError(errorMessage(err));
      ScratchpadNotifications.error({ title: 'Create failed', message: errorMessage(err) });
    } finally {
      setIsCreating(false);
    }
  };

  const busy = isValidating || isCreating || isGeneratingPlan;
  const title = (
    <Group gap={10} align="center">
      <StyledLucideIcon Icon={DatabaseIcon} size="md" />
      <span>Create tables and fields — {service}</span>
    </Group>
  );

  return (
    <Modal opened={opened} onClose={onClose} title={title} size="80%">
      <Stack gap="lg">
        <SegmentedControl
          fullWidth
          data={[
            { value: 'createTables', label: 'Create tables' },
            { value: 'createFields', label: 'Add fields to existing table' },
          ]}
          value={mode}
          onChange={(value) => {
            setMode(value as SchemaMode);
            clearResults();
          }}
        />

        <CreateSchemaResults
          error={error}
          validateResult={validateResult}
          createResult={createResult}
          planResult={planResult}
        />

        {mode === 'createTables' ? (
          <Stack gap="md">
            <Group gap="sm" align="flex-end">
              <Select
                label="Copy from folder (optional)"
                description="Prefill the plan from an existing data folder's schema"
                placeholder={sourceFolderGroups.length ? 'Pick a source folder' : 'No data folders in this workbook'}
                data={sourceFolderGroups}
                value={copySourceFolderId || null}
                onChange={(value) => setCopySourceFolderId(value ?? '')}
                searchable
                clearable
                disabled={sourceFolderGroups.length === 0}
                style={{ flex: 1 }}
              />
              <Select
                label="Into existing table (optional)"
                description="Diff against an existing table and add only the missing fields"
                placeholder={connectorFolders.length ? 'Create a new table' : 'No tables for this connector'}
                data={connectorFolders.map((folder) => ({
                  value: folder.id,
                  label: `${folder.name} (${folder.tableId.join('/')})`,
                }))}
                value={copyDestinationDataFolderId || null}
                onChange={(value) => setCopyDestinationDataFolderId(value ?? '')}
                searchable
                clearable
                disabled={connectorFolders.length === 0}
                style={{ flex: 1 }}
              />
              <ButtonSecondaryOutline
                leftSection={<StyledLucideIcon Icon={CopyIcon} size="sm" />}
                onClick={() => void handleCopyFromFolder()}
                loading={isGeneratingPlan}
                disabled={!copySourceFolderId}
              >
                Copy
              </ButtonSecondaryOutline>
            </Group>
            <Group gap="md" align="flex-end">
              {destinations && destinations.length > 0 ? (
                <Select
                  label="Remote parent (optional)"
                  description="Where to create the table (e.g. base / schema)"
                  placeholder="Pick a destination"
                  data={destinations.map((destination) => ({ value: destination.id, label: destination.name }))}
                  value={remoteParentId || null}
                  onChange={(value) => setRemoteParentId(value ?? '')}
                  searchable
                  clearable
                  style={{ flex: 1 }}
                />
              ) : (
                <TextInput
                  label="Remote parent id (optional)"
                  description={isLoadingDestinations ? 'Loading destinations…' : 'Base / parent / schema'}
                  placeholder="e.g. public"
                  value={remoteParentId}
                  onChange={(event) => setRemoteParentId(event.currentTarget.value)}
                  disabled={isLoadingDestinations}
                  style={{ flex: 1 }}
                />
              )}
              <Checkbox
                label="Materialize locally"
                checked={materializeLocally}
                onChange={(event) => setMaterializeLocally(event.currentTarget.checked)}
              />
            </Group>
            {materializeLocally && (
              <TextInput
                label="Parent folder id (optional)"
                description="Where to nest the materialized folders"
                value={parentFolderId}
                onChange={(event) => setParentFolderId(event.currentTarget.value)}
              />
            )}

            {tables.map((table, index) => (
              <CreateSchemaTableEditor
                key={table.id}
                table={table}
                index={index}
                onChange={(updates) => updateTable(table.id, updates)}
                onRemove={() => removeTable(table.id)}
                canRemove={tables.length > 1}
                allTableRefs={allTableRefs}
                existingTableOptions={existingTableOptions}
              />
            ))}

            <Group>
              <ButtonSecondaryOutline leftSection={<StyledLucideIcon Icon={PlusIcon} size="sm" />} onClick={addTable}>
                Add table
              </ButtonSecondaryOutline>
            </Group>
          </Stack>
        ) : (
          <Stack gap="md">
            {connectorFolders.length > 0 ? (
              <Select
                label="Existing table"
                description="A table (data folder) for this connector to add fields to"
                placeholder="Pick a table"
                data={connectorFolders.map((folder) => ({
                  value: folder.id,
                  label: `${folder.name} (${folder.tableId.join('/')})`,
                }))}
                value={selectedDataFolderId || null}
                onChange={(value) => setSelectedDataFolderId(value ?? '')}
                searchable
                clearable
              />
            ) : (
              <TextInput
                label="Existing remote table id"
                description="No data folders found for this connector — enter the remote id directly (use / for path segments)."
                placeholder="e.g. public/customers"
                value={remoteTableIdText}
                onChange={(event) => setRemoteTableIdText(event.currentTarget.value)}
              />
            )}
            <Text12Regular c="var(--fg-secondary)">Fields to add</Text12Regular>
            <Stack gap="sm">
              {existingFields.map((field) => (
                <CreateSchemaFieldRow
                  key={field.id}
                  field={field}
                  onChange={(updates) => updateExistingField(field.id, updates)}
                  onRemove={() => removeExistingField(field.id)}
                  siblingTableRefs={[]}
                  allowForeignKeyRef={false}
                  existingTableOptions={existingTableOptions}
                  hasDuplicateName={duplicateExistingFieldNameIds.has(field.id)}
                />
              ))}
            </Stack>
            <Group>
              <ButtonSecondaryOutline
                leftSection={<StyledLucideIcon Icon={PlusIcon} size="sm" />}
                onClick={addExistingField}
              >
                Add field
              </ButtonSecondaryOutline>
            </Group>
          </Stack>
        )}

        <Divider />

        <Group justify="space-between">
          <ButtonDangerLight
            leftSection={<StyledLucideIcon Icon={RotateCcwIcon} size="sm" />}
            onClick={handleReset}
            disabled={busy}
          >
            Reset
          </ButtonDangerLight>
          <Group gap="sm">
            <ButtonSecondaryOutline
              onClick={() => void handleValidate()}
              loading={isValidating}
              disabled={isCreating || isGeneratingPlan}
            >
              Validate
            </ButtonSecondaryOutline>
            <ButtonPrimarySolid
              onClick={() => void handleCreate()}
              loading={isCreating}
              disabled={isValidating || isGeneratingPlan}
            >
              {mode === 'createTables' ? 'Create tables' : 'Create fields'}
            </ButtonPrimarySolid>
          </Group>
        </Group>
      </Stack>

      <ConfirmDialog {...dialogProps} />
    </Modal>
  );
}
