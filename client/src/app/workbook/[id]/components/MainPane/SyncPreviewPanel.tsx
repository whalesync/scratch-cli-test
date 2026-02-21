'use client';

import { Text13Medium } from '@/app/components/base/text';
import { useFolderFileList } from '@/hooks/use-folder-file-list';
import { getHumanReadableErrorMessage } from '@/lib/api/error';
import { syncApi } from '@/lib/api/sync';
import { Alert, Badge, Box, Code, Collapse, Group, Select, Spoiler, Stack, Table } from '@mantine/core';
import type {
  ColumnMapping,
  DataFolderId,
  PreviewFieldResult,
  TransformerConfig,
  WorkbookId,
} from '@spinner/shared-types';
import { AlertTriangle, ChevronDown, ChevronUp, Eye } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

interface FieldMapping {
  id: string;
  sourceField: string;
  destField: string;
  transformer?: TransformerConfig;
}

interface SyncPreviewPanelProps {
  workbookId: WorkbookId;
  sourceId: string;
  fieldMappings: FieldMapping[];
}

export function SyncPreviewPanel({ workbookId, sourceId, fieldMappings }: SyncPreviewPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<PreviewFieldResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { files } = useFolderFileList(workbookId, (sourceId || null) as DataFolderId | null);

  const fileOptions = useMemo(
    () =>
      files
        .filter((f) => f.type === 'file' && f.path.endsWith('.json'))
        .map((f) => ({ value: f.path, label: f.name || f.path })),
    [files],
  );

  const hasValidMappings = useMemo(() => fieldMappings.some((m) => m.sourceField && m.destField), [fieldMappings]);

  const canPreview = !!sourceId && hasValidMappings && !!selectedFile;

  const buildColumnMappings = useCallback((): ColumnMapping[] => {
    const columnMappings: ColumnMapping[] = [];
    for (const m of fieldMappings) {
      if (m.sourceField && m.destField) {
        const mapping: ColumnMapping = {
          sourceColumnId: m.sourceField,
          destinationColumnId: m.destField,
        };
        if (m.transformer) {
          mapping.transformer = m.transformer;
        }
        columnMappings.push(mapping);
      }
    }
    return columnMappings;
  }, [fieldMappings]);

  const handlePreview = async () => {
    if (!canPreview) return;
    setLoading(true);
    setError(null);
    setResults(null);
    try {
      const columnMappings = buildColumnMappings();
      const response = await syncApi.previewRecord(workbookId, sourceId, selectedFile!, columnMappings);
      setResults(response.fields);
    } catch (err) {
      setError(getHumanReadableErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  if (!sourceId) return null;

  return (
    <Box
      mt="xs"
      style={{
        border: '1px solid var(--mantine-color-default-border)',
        borderRadius: 'var(--mantine-radius-sm)',
      }}
    >
      <Group p="xs" style={{ cursor: 'pointer' }} onClick={() => setExpanded((v) => !v)} gap="xs">
        <Eye size={14} color="var(--mantine-color-dimmed)" />
        <Text13Medium style={{ flex: 1 }}>Preview</Text13Medium>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </Group>

      <Collapse in={expanded}>
        <Stack p="xs" pt={0} gap="xs">
          <Group gap="xs" align="flex-end">
            <Select
              label="Source record"
              placeholder="Select a record"
              data={fileOptions}
              value={selectedFile}
              onChange={setSelectedFile}
              searchable
              style={{ flex: 1 }}
              size="xs"
            />
            <Badge
              component="button"
              onClick={handlePreview}
              variant="light"
              color="blue"
              style={{
                cursor: canPreview && !loading ? 'pointer' : 'default',
                opacity: canPreview && !loading ? 1 : 0.5,
                marginBottom: 1,
              }}
            >
              {loading ? 'Loading...' : 'Preview'}
            </Badge>
          </Group>

          {error && (
            <Badge color="red" variant="light" size="lg" style={{ whiteSpace: 'normal', height: 'auto', padding: 8 }}>
              {error}
            </Badge>
          )}

          {results && (
            <Box style={{ overflowX: 'auto' }}>
              <Table striped highlightOnHover withTableBorder withColumnBorders fz="xs">
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Source Field</Table.Th>
                    <Table.Th>Source Value</Table.Th>
                    <Table.Th></Table.Th>
                    <Table.Th>Destination Field</Table.Th>
                    <Table.Th>Result</Table.Th>
                    <Table.Th>Transformer</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {results.map((field, i) => (
                    <Table.Tr key={i}>
                      <Table.Td>
                        <Code fz="xs">{field.sourceField}</Code>
                      </Table.Td>
                      <Table.Td style={{ maxWidth: 200, verticalAlign: 'top' }}>
                        <div style={{ maxHeight: 120, overflow: 'auto' }}>
                          <Code fz="xs" block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                            {formatValue(field.sourceValue)}
                          </Code>
                        </div>
                      </Table.Td>
                      <Table.Td style={{ textAlign: 'center', width: 30 }}>→</Table.Td>
                      <Table.Td>
                        <Code fz="xs">{field.destinationField}</Code>
                      </Table.Td>
                      <Table.Td style={{ maxWidth: 200, verticalAlign: 'top' }}>
                        <div style={{ maxHeight: 120, overflow: 'auto' }}>
                          <Code fz="xs" block style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                            {formatValue(field.transformedValue)}
                          </Code>
                        </div>
                        {field.warning && <ExpandableError message={field.warning} />}
                      </Table.Td>
                      <Table.Td>
                        {field.transformerType && (
                          <Badge size="xs" variant="light" color="blue">
                            {field.transformerType.replaceAll('_', ' ')}
                          </Badge>
                        )}
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Box>
          )}
        </Stack>
      </Collapse>
    </Box>
  );
}

function ExpandableError({ message }: { message: string }) {
  return (
    <Alert color="red" mt={4} p="xs" fz="xs" icon={<AlertTriangle size={14} />}>
      <Spoiler maxHeight={50} showLabel="Show more" hideLabel="Show less" fz="xs">
        {message}
      </Spoiler>
    </Alert>
  );
}

function formatValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}
