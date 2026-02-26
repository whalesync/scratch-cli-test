import { workbookApi } from '@/lib/api/workbook';
import { Autocomplete, Badge, Button, Code, Group, Modal, Select, Stack, Text, Title } from '@mantine/core';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import {
  FileRefEntity,
  TestTransformerResponse,
  TRANSFORMER_TYPES,
  TransformerType,
  WorkbookId,
} from '@spinner/shared-types';
import { FlaskRoundIcon, Search, Wand2Icon } from 'lucide-react';
import { useEffect, useState } from 'react';

interface TestTransformerModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: WorkbookId;
  file: FileRefEntity;
}

const transformerSelectData = TRANSFORMER_TYPES.map((t) => ({ value: t.type, label: t.label }));

interface PathOption {
  value: string;
  label: string;
  type: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const renderAutocompleteOption = ({ option }: any) => (
  <Group gap="sm" wrap="nowrap">
    <Badge size="xs" variant="light" color="blue" w={70} style={{ flexShrink: 0 }}>
      {option.type}
    </Badge>
    <Text size="sm">{option.value}</Text>
  </Group>
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function flattenKeys(obj: any, prefix = ''): PathOption[] {
  const keys: PathOption[] = [];
  for (const key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      const newKey = prefix ? `${prefix}.${key}` : key;
      const value = obj[key];
      const type = Array.isArray(value) ? 'array' : typeof value;

      keys.push({ value: newKey, label: newKey, type });

      if (typeof value === 'object' && value !== null) {
        if (Array.isArray(value)) {
          // For arrays, maybe add index 0 to show structure, or just the array itself
          // keys.push(...flattenKeys(obj[key], newKey));
          // Arrays index notation like [0]
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          value.forEach((item: any, index: number) => {
            if (typeof item === 'object' && item !== null) {
              keys.push(...flattenKeys(item, `${newKey}[${index}]`));
            } else {
              keys.push({ value: `${newKey}[${index}]`, label: `${newKey}[${index}]`, type: typeof item });
            }
          });
        } else {
          keys.push(...flattenKeys(value, newKey));
        }
      }
    }
  }
  return keys;
}

export function TestTransformerModal({ opened, onClose, workbookId, file }: TestTransformerModalProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [result, setResult] = useState<TestTransformerResponse | null>(null);
  const [paths, setPaths] = useState<PathOption[]>([]);
  const [fetchingPaths, setFetchingPaths] = useState(false);
  const [prettify, setPrettify] = useState(false);

  // Simple HTML formatter
  const formatHtml = (html: string) => {
    let formatted = '';
    let indent = 0;
    const tab = '  ';
    html.split(/>\s*</).forEach((element) => {
      if (element.match(/^\/\w/)) {
        indent -= 1;
      }
      formatted += tab.repeat(Math.max(0, indent)) + '<' + element + '>\n';
      if (
        element.match(/^<?\w[^>]*[^\/]$/) &&
        !element.startsWith('input') &&
        !element.startsWith('img') &&
        !element.startsWith('br')
      ) {
        indent += 1;
      }
    });
    return formatted.substring(1, formatted.length - 2);
  };

  // Fetch file content when opened
  useEffect(() => {
    if (opened) {
      setFetchingPaths(true);
      setPaths([]); // Clear previous paths
      workbookApi
        .getRepoFile(workbookId, file.path)
        .then((res) => {
          try {
            const json = JSON.parse(res.content);
            const flattened = flattenKeys(json);
            console.log('Flattened paths:', flattened); // Debug log
            setPaths(flattened);
          } catch (e) {
            console.warn('Failed to parse file content or flatten keys', e);
          }
        })
        .catch((err) => {
          console.error('Failed to fetch file content', err);
        })
        .finally(() => {
          setFetchingPaths(false);
        });
    }
  }, [opened, workbookId, file.path]);

  const form = useForm({
    initialValues: {
      path: '',
      transformerType: 'notion_to_html' as TransformerType,
    },
    validate: {
      path: (value) => (value ? null : 'Path is required'),
      transformerType: (value) => (value ? null : 'Transformer type is required'),
    },
  });

  const handleSubmit = async (values: typeof form.values) => {
    setIsLoading(true);
    setResult(null);
    try {
      const response = await workbookApi.testTransformer(workbookId, {
        workbookId,
        fileId: file.path, // Using path as ID for now as per server implementation
        path: values.path,
        transformerConfig: {
          type: values.transformerType,
          options: {}, // Default options for now
          // For complex transformers, we'd need more inputs here
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      });
      setResult(response);
    } catch (error) {
      console.error(error);
      notifications.show({
        title: 'Error',
        message: 'Failed to test transformer',
        color: 'red',
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={
        <Group gap="xs">
          <FlaskRoundIcon size={20} />
          <Title order={4}>Test Transformer</Title>
        </Group>
      }
      size="lg"
    >
      <Stack>
        <Text size="sm" c="dimmed">
          Testing on file: <Code>{file.name}</Code>
        </Text>

        <form onSubmit={form.onSubmit(handleSubmit)}>
          <Stack gap="md">
            <Autocomplete
              label="JSON Path"
              placeholder={fetchingPaths ? 'Loading paths...' : 'e.g. properties.Name.title[0].plain_text'}
              description="Dot notation path to the value in the JSON file"
              data={paths}
              disabled={fetchingPaths}
              renderOption={renderAutocompleteOption}
              rightSection={<Search size={14} color="var(--mantine-color-dimmed)" />}
              {...form.getInputProps('path')}
            />

            <Select label="Transformer" data={transformerSelectData} {...form.getInputProps('transformerType')} />

            <Button type="submit" loading={isLoading}>
              Apply
            </Button>
          </Stack>
        </form>

        {result && (
          <Stack gap="xs" mt="md" p="md" bg="var(--mantine-color-gray-0)" style={{ borderRadius: 8 }}>
            <Text size="sm" fw={500}>
              Result:
            </Text>
            {result.success ? (
              <>
                <Group align="flex-start">
                  {/* Original value removed as per user request */}
                  <Stack gap={4} style={{ flex: 1 }}>
                    <Group justify="flex-start" align="center" gap="md">
                      <Text size="xs" c="dimmed">
                        Transformed
                      </Text>
                      {typeof result.value === 'string' && result.value.trim().startsWith('<') && (
                        <Button
                          size="xs"
                          variant="light"
                          leftSection={<Wand2Icon size={14} />}
                          onClick={() => setPrettify(!prettify)}
                        >
                          {prettify ? 'Raw' : 'Prettify'}
                        </Button>
                      )}
                    </Group>
                    <Code block style={{ flex: 1, overflow: 'auto', maxHeight: 400 }}>
                      {prettify && typeof result.value === 'string'
                        ? formatHtml(result.value)
                        : typeof result.value === 'object'
                          ? JSON.stringify(result.value, null, 2)
                          : String(result.value)}
                    </Code>
                  </Stack>
                </Group>
              </>
            ) : (
              <Text c="red" size="sm">
                {result.error}
              </Text>
            )}
          </Stack>
        )}
      </Stack>
    </Modal>
  );
}
