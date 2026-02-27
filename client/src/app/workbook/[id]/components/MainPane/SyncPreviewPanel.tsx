'use client';

import { Text13Medium, Text13Regular } from '@/app/components/base/text';
import { useFolderFileList } from '@/hooks/use-folder-file-list';
import { getHumanReadableErrorMessage } from '@/lib/api/error';
import { syncApi } from '@/lib/api/sync';
import { Alert, Badge, Box, Code, Collapse, Group, Loader, Select, Spoiler, Stack, Table } from '@mantine/core';
import type {
  ColumnMapping,
  DataFolderId,
  PreviewFieldResult,
  TransformerConfig,
  TransformerType,
  WorkbookId,
} from '@spinner/shared-types';
import { getTransformerLabel } from '@spinner/shared-types';
import { AlertTriangle, ChevronDown, ChevronUp, Eye } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

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
  const [recordId, setRecordId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectRef = useRef<HTMLInputElement>(null);
  const prevSourceIdRef = useRef(sourceId);

  const { files, isLoading: filesLoading } = useFolderFileList(workbookId, (sourceId || null) as DataFolderId | null);

  const fileOptions = useMemo(
    () =>
      files
        .filter((f) => f.type === 'file' && f.path.endsWith('.json'))
        .map((f) => ({ value: f.path, label: f.name || f.path })),
    [files],
  );

  const mappingsFingerprint = JSON.stringify(fieldMappings);

  const hasValidMappings = useMemo(
    () => fieldMappings.some((m) => m.sourceField && m.destField),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mappingsFingerprint],
  );

  const canPreview = !!sourceId && hasValidMappings && !!selectedFile;

  // Auto-expand when preview becomes possible
  useEffect(() => {
    if (canPreview) setExpanded(true);
  }, [canPreview]);

  // Reset state when sourceId changes
  useEffect(() => {
    if (prevSourceIdRef.current !== sourceId) {
      prevSourceIdRef.current = sourceId;
      setSelectedFile(null);
      setResults(null);
      setRecordId(null);
      setError(null);
    }
  }, [sourceId]);

  // Auto-select first file, and clear selection if it's no longer in the options (e.g. source changed)
  useEffect(() => {
    if (selectedFile && fileOptions.length > 0 && !fileOptions.some((f) => f.value === selectedFile)) {
      setSelectedFile(null);
      return;
    }
    if (!selectedFile && fileOptions.length > 0) {
      setSelectedFile(fileOptions[0].value);
    }
  }, [fileOptions, selectedFile]);

  // Auto-run preview when inputs change (debounced, with abort for stale responses)
  useEffect(() => {
    if (!canPreview) return;
    const abortController = new AbortController();
    // Capture mappings by value to avoid stale closure on mutable array
    const capturedMappings = JSON.parse(mappingsFingerprint) as FieldMapping[];
    const timer = setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const columnMappings: ColumnMapping[] = capturedMappings
          .filter((m) => m.sourceField && m.destField)
          .map((m) => ({
            sourceColumnId: m.sourceField,
            destinationColumnId: m.destField,
            ...(m.transformer ? { transformer: m.transformer } : {}),
          }));
        const response = await syncApi.previewRecord(workbookId, sourceId, selectedFile!, columnMappings);
        if (abortController.signal.aborted) return;
        setResults(response.fields);
        setRecordId(response.recordId);
      } catch (err) {
        if (abortController.signal.aborted) return;
        setError(getHumanReadableErrorMessage(err));
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      abortController.abort();
    };
  }, [canPreview, mappingsFingerprint, selectedFile, sourceId, workbookId]);

  const handleFileChange = (value: string | null) => {
    setSelectedFile(value);
    if (value === null) {
      setResults(null);
      setRecordId(null);
      setError(null);
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
        <Text13Medium style={{ flex: 1 }}>
          Preview
          {!expanded && results && (
            <span
              style={{
                display: 'inline-block',
                width: 8,
                height: 8,
                borderRadius: '50%',
                backgroundColor: 'var(--mantine-color-green-6)',
                marginLeft: 6,
                verticalAlign: 'middle',
              }}
            />
          )}
        </Text13Medium>
        {loading && <Loader size={12} />}
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </Group>

      <Collapse in={expanded}>
        <Stack p="xs" pt={0} gap="xs">
          {!hasValidMappings && (
            <Text13Regular c="dimmed">Add at least one field mapping to preview results.</Text13Regular>
          )}
          <Select
            ref={selectRef}
            label="Source record"
            placeholder={filesLoading ? 'Loading files...' : 'Select a record'}
            data={fileOptions}
            value={selectedFile}
            onChange={handleFileChange}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                selectRef.current?.click();
              }
            }}
            searchable
            allowDeselect={false}
            nothingFoundMessage="No JSON files found"
            size="xs"
          />

          {error && (
            <Badge color="red" variant="light" size="lg" style={{ whiteSpace: 'normal', height: 'auto', padding: 8 }}>
              {error}
            </Badge>
          )}

          {results && (
            <Box style={{ overflowX: 'auto' }}>
              {recordId && (
                <Text13Regular mb={4}>
                  Record: <Code fz="xs">{recordId}</Code>
                </Text13Regular>
              )}
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
                  {results.map((field) => (
                    <Table.Tr key={`${field.sourceField}-${field.destinationField}`}>
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
                            {getTransformerLabel(field.transformerType as TransformerType)}
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
