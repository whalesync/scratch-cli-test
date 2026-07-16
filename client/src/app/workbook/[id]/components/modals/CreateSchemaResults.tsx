'use client';

import { Badge } from '@/app/components/base/badge';
import { Text12Regular, Text13Medium, Text13Regular, TextMono12Regular } from '@/app/components/base/text';
import { Accordion, Alert, Card, Group, Stack } from '@mantine/core';
import type {
  CreateFieldResult,
  CreateSchemaFieldsResponse,
  CreateSchemaStatus,
  CreateSchemaTablesResponse,
  CreateTableResult,
  FieldMappingNote,
  TableMappingNote,
  ValidateSchemaResponse,
} from '@spinner/shared-types';

type CreateResult = CreateSchemaTablesResponse | CreateSchemaFieldsResponse;

export interface PlanResult {
  notes: FieldMappingNote[];
  tableNotes: TableMappingNote[];
  destinationSupportsCreation: boolean;
}

interface CreateSchemaResultsProps {
  error: string | null;
  validateResult: ValidateSchemaResponse | null;
  createResult: CreateResult | null;
  planResult: PlanResult | null;
}

// The base Badge supports a fixed color set (no yellow), so 'partial'/'skipped'
// map to the neutral gray.
function statusColor(status: string): 'green' | 'red' | 'gray' {
  switch (status) {
    case 'ok':
    case 'created':
      return 'green';
    case 'partial':
    case 'skipped':
      return 'gray';
    default:
      // 'failed', 'not_supported', anything else
      return 'red';
  }
}

function overallAlertColor(status: CreateSchemaStatus): string {
  if (status === 'ok') return 'green';
  if (status === 'partial') return 'yellow';
  return 'red';
}

export function CreateSchemaResults({ error, validateResult, createResult, planResult }: CreateSchemaResultsProps) {
  if (!error && !validateResult && !createResult && !planResult) return null;

  return (
    <Stack gap="md">
      {error && (
        <Alert color="red" variant="light" title="Request failed">
          {error}
        </Alert>
      )}

      {planResult && <PlanResultView planResult={planResult} />}

      {validateResult && <ValidateResultView result={validateResult} />}

      {createResult && <CreateResultView result={createResult} />}
    </Stack>
  );
}

function noteColor(status: FieldMappingNote['status']): 'green' | 'gray' | 'red' {
  if (status === 'mapped') return 'green';
  if (status === 'downgraded') return 'gray';
  if (status === 'exists') return 'gray'; // already on destination — skipped, not an error
  if (status === 'skipped_reciprocal') return 'gray'; // other side of a symmetric link suggested instead — intentional
  return 'red'; // unsupported / needs_target — needs action before this field can be created
}

function PlanResultView({ planResult }: { planResult: PlanResult }) {
  const mappedCount = planResult.notes.filter((note) => note.status === 'mapped').length;
  const downgraded = planResult.notes.filter((note) => note.status === 'downgraded');
  const unsupported = planResult.notes.filter((note) => note.status === 'unsupported');
  // Recognized foreign keys kept in the plan but still needing a destination table.
  const needsTarget = planResult.notes.filter((note) => note.status === 'needs_target');
  const exists = planResult.notes.filter((note) => note.status === 'exists');
  // Symmetric-service link fields omitted because the other side is suggested instead (DEV-10753).
  const skippedReciprocal = planResult.notes.filter((note) => note.status === 'skipped_reciprocal');
  const mapped = planResult.notes.filter((note) => note.status === 'mapped');
  const tableNotes = planResult.tableNotes;
  // All notes, most-severe first, for the collapsible details panel.
  const orderedNotes = [...unsupported, ...needsTarget, ...downgraded, ...exists, ...skippedReciprocal, ...mapped];

  return (
    <Stack gap="sm">
      <Alert
        color={planResult.destinationSupportsCreation ? 'blue' : 'yellow'}
        variant="light"
        title="Plan generated from folder"
      >
        {!planResult.destinationSupportsCreation && (
          <Text13Regular>
            The destination connector does not support schema creation — Create will return not_supported.
          </Text13Regular>
        )}
        <Text13Regular>
          {mappedCount} field{mappedCount === 1 ? '' : 's'} mapped
          {downgraded.length > 0 ? `, ${downgraded.length} downgraded` : ''}
          {exists.length > 0 ? `, ${exists.length} already on destination (skipped)` : ''}
          {skippedReciprocal.length > 0
            ? `, ${skippedReciprocal.length} reciprocal link${skippedReciprocal.length === 1 ? '' : 's'} omitted`
            : ''}
          {needsTarget.length > 0 ? `, ${needsTarget.length} need a destination table` : ''}
          {unsupported.length > 0 ? `, ${unsupported.length} unsupported (omitted)` : ''}
          {tableNotes.length > 0 ? `, ${tableNotes.length} table${tableNotes.length === 1 ? '' : 's'} renamed` : ''}.
        </Text13Regular>
      </Alert>
      {(orderedNotes.length > 0 || tableNotes.length > 0) && (
        <Accordion variant="contained" multiple>
          {tableNotes.length > 0 && (
            <Accordion.Item value="table-notes">
              <Accordion.Control>Table name changes ({tableNotes.length})</Accordion.Control>
              <Accordion.Panel>
                <Stack gap="sm">
                  {tableNotes.map((note, index) => (
                    <Stack key={index} gap={2}>
                      <Group gap="xs" align="center" wrap="nowrap">
                        <Badge color="gray">renamed</Badge>
                        <Text13Medium>{note.renamedFromName}</Text13Medium>
                        <TextMono12Regular c="var(--fg-muted)">→ {note.tableName}</TextMono12Regular>
                      </Group>
                      <Text12Regular c="var(--fg-secondary)">{note.message}</Text12Regular>
                    </Stack>
                  ))}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          )}
          {orderedNotes.length > 0 && (
            <Accordion.Item value="plan-notes">
              <Accordion.Control>Field mapping notes ({orderedNotes.length})</Accordion.Control>
              <Accordion.Panel>
                <Stack gap="sm">
                  {orderedNotes.map((note, index) => (
                    <Stack key={index} gap={2}>
                      <Group gap="xs" align="center" wrap="nowrap">
                        <Badge color={noteColor(note.status)}>{note.status}</Badge>
                        <Text13Medium>{note.fieldName}</Text13Medium>
                        {note.renamedFromName && (
                          <TextMono12Regular c="var(--fg-muted)">was: {note.renamedFromName}</TextMono12Regular>
                        )}
                        {note.mappedKind && (
                          <TextMono12Regular c="var(--fg-muted)">→ {note.mappedKind}</TextMono12Regular>
                        )}
                      </Group>
                      {note.message && <Text12Regular c="var(--fg-secondary)">{note.message}</Text12Regular>}
                    </Stack>
                  ))}
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          )}
        </Accordion>
      )}
    </Stack>
  );
}

function ValidateResultView({ result }: { result: ValidateSchemaResponse }) {
  if (!result.schemaCreationSupported) {
    return (
      <Alert color="red" variant="light" title="Schema creation not supported">
        The connector for <strong>{result.service}</strong> does not support creating tables or fields.
      </Alert>
    );
  }
  if (result.valid) {
    return (
      <Alert color="green" variant="light" title="Plan is valid">
        Validation passed — no issues found.
      </Alert>
    );
  }
  return (
    <Alert
      color="red"
      variant="light"
      title={`Validation failed (${result.issues.length} issue${result.issues.length === 1 ? '' : 's'})`}
    >
      <Stack gap="xs" mt="xs">
        {result.issues.map((issue, index) => (
          <Card key={index} withBorder padding="xs" radius="sm">
            <Group gap="xs" align="center" wrap="nowrap">
              <Badge color="red">{issue.code}</Badge>
              <TextMono12Regular c="var(--fg-secondary)">{issue.path || '(root)'}</TextMono12Regular>
            </Group>
            <Text13Regular mt={4}>{issue.message}</Text13Regular>
          </Card>
        ))}
      </Stack>
    </Alert>
  );
}

function CreateResultView({ result }: { result: CreateResult }) {
  return (
    <Stack gap="sm">
      <Alert color={overallAlertColor(result.status)} variant="light" title={`Create result: ${result.status}`}>
        {result.unsupported && (
          <Text13Regular>
            {result.unsupported.service}: {result.unsupported.message}
          </Text13Regular>
        )}
      </Alert>

      {'tables' in result
        ? result.tables.map((table) => <TableResultCard key={table.ref} table={table} />)
        : result.fields.length > 0 && (
            <Card withBorder padding="sm" radius="sm">
              <Stack gap="xs">
                <Group gap="xs">
                  <Text13Medium>Remote table</Text13Medium>
                  <TextMono12Regular c="var(--fg-secondary)">{result.remoteTableId.join('/')}</TextMono12Regular>
                </Group>
                <FieldResultList fields={result.fields} />
              </Stack>
            </Card>
          )}
    </Stack>
  );
}

function TableResultCard({ table }: { table: CreateTableResult }) {
  return (
    <Card withBorder padding="sm" radius="sm">
      <Stack gap="xs">
        <Group gap="xs" align="center" wrap="nowrap">
          <Badge color={statusColor(table.status)}>{table.status}</Badge>
          <Text13Medium>{table.name}</Text13Medium>
          <TextMono12Regular c="var(--fg-secondary)">{table.ref}</TextMono12Regular>
          {table.remoteTableId && (
            <TextMono12Regular c="var(--fg-muted)">→ {table.remoteTableId.join('/')}</TextMono12Regular>
          )}
        </Group>
        {table.error && <Text12Regular c="var(--mantine-color-red-6)">{table.error}</Text12Regular>}
        {table.materializeError && (
          <Text12Regular c="var(--mantine-color-yellow-6)">Materialize: {table.materializeError}</Text12Regular>
        )}
        {table.dataFolderId && <Text12Regular c="var(--fg-muted)">Local folder: {table.dataFolderId}</Text12Regular>}
        {table.fields.length > 0 && <FieldResultList fields={table.fields} />}
      </Stack>
    </Card>
  );
}

function FieldResultList({ fields }: { fields: CreateFieldResult[] }) {
  return (
    <Stack gap={4}>
      {fields.map((field, index) => (
        <Group key={index} gap="xs" align="center" wrap="nowrap">
          <Badge color={statusColor(field.status)}>{field.status}</Badge>
          <Text12Regular>{field.name}</Text12Regular>
          {field.remoteFieldId && <TextMono12Regular c="var(--fg-muted)">{field.remoteFieldId}</TextMono12Regular>}
          {field.autoAdded && <Text12Regular c="var(--fg-muted)">(auto-added)</Text12Regular>}
          {field.error && <Text12Regular c="var(--mantine-color-red-6)">{field.error}</Text12Regular>}
        </Group>
      ))}
    </Stack>
  );
}
