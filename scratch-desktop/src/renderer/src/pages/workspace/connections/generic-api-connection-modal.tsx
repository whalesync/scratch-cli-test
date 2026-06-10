import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/components/base/buttons';
import { useConnectorAccounts } from '@/hooks/use-connector-accounts';
import { scratchApiClient } from '@/lib/scratch-api-client';
import {
  ActionIcon,
  Alert,
  Divider,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type {
  ConnectorAccount,
  GenericApiConnectorExtras,
  GenericApiEndpointOverrides,
  GenericApiGraphqlEndpoint,
  GenericApiRestEndpoint,
} from '@spinner/shared-types';
import { isGenericApiConnectorExtras, validatePastedConfig } from '@spinner/shared-types';
import { CopyIcon, PlusIcon, SettingsIcon, SparklesIcon, Trash2Icon } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

// ─────────────────────────────────────────────────────────────────────────────
// Props & constants
// ─────────────────────────────────────────────────────────────────────────────

export interface GenericApiConnectionModalProps {
  opened: boolean;
  onClose: () => void;
  workbookId: string;
  existingAccount?: ConnectorAccount | null;
  onConnectionCreated?: (account: ConnectorAccount) => void;
  onConnectionUpdated?: (account: ConnectorAccount) => void;
}

type ApiType = 'rest' | 'graphql';
type AuthStyleSelection = 'bearer' | 'token' | 'raw' | 'custom-header';

const AUTH_OPTIONS: Array<{ value: AuthStyleSelection; label: string }> = [
  { value: 'bearer', label: 'Authorization: Bearer <key>' },
  { value: 'token', label: 'Authorization: Token <key>' },
  { value: 'raw', label: 'Authorization: <key>' },
  { value: 'custom-header', label: 'Custom header (e.g. X-API-Key)' },
];

const newEndpointId = () => `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const blankRestEndpoint = (): GenericApiRestEndpoint => ({
  id: newEndpointId(),
  method: 'GET',
  url: '',
  name: '',
});

const blankGraphqlEndpoint = (): GenericApiGraphqlEndpoint => ({
  id: newEndpointId(),
  url: '',
  query: '',
  name: '',
});

const isEndpointsEmpty = (apiType: ApiType, rest: GenericApiRestEndpoint[], gql: GenericApiGraphqlEndpoint[]) => {
  const list = apiType === 'rest' ? rest : gql;
  return list.every((e) => !e.url.trim() && !(e as GenericApiGraphqlEndpoint).query?.trim());
};

const URL_MAX_DISPLAY_CHARS = 50;
const truncateMiddle = (s: string, max: number): string => {
  if (s.length <= max) return s;
  const headLen = Math.ceil((max - 1) * 0.75);
  const tailLen = max - 1 - headLen;
  return s.slice(0, headLen) + '…' + (tailLen > 0 ? s.slice(s.length - tailLen) : '');
};

const cleanOverrides = (o: GenericApiEndpointOverrides | undefined): GenericApiEndpointOverrides | undefined => {
  if (!o) return undefined;
  const cleanLeaf = <T extends Record<string, unknown>>(obj: T | undefined): Partial<T> | undefined => {
    if (!obj) return undefined;
    const out: Partial<T> = {};
    for (const k of Object.keys(obj) as Array<keyof T>) {
      const v = obj[k];
      if (v !== undefined && v !== '' && v !== null) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  };
  const next: GenericApiEndpointOverrides = {};
  if (o.paginationType) next.paginationType = o.paginationType;
  if (o.maxPages !== undefined) next.maxPages = o.maxPages;
  if (o.enrichUrl && o.enrichUrl.trim()) next.enrichUrl = o.enrichUrl.trim();
  const req = cleanLeaf(o.request);
  if (req) next.request = req;
  const res = cleanLeaf(o.response);
  if (res) next.response = res;
  return Object.keys(next).length > 0 ? next : undefined;
};

const copyConfigJson = async (extras: GenericApiConnectorExtras) => {
  try {
    await navigator.clipboard.writeText(JSON.stringify(extras, null, 2));
    notifications.show({ title: 'Config JSON copied', message: 'Paste it anywhere.', color: 'teal' });
  } catch (e) {
    notifications.show({
      title: 'Failed to copy',
      message: e instanceof Error ? e.message : 'Unknown error',
      color: 'red',
    });
  }
};

const describeAuth = (style: AuthStyleSelection, customHeaderName: string): string => {
  switch (style) {
    case 'bearer':
      return 'Authorization: Bearer';
    case 'token':
      return 'Authorization: Token';
    case 'raw':
      return 'Authorization (raw)';
    case 'custom-header':
      return `${customHeaderName.trim() || 'X-API-Key'} header`;
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Main modal
// ─────────────────────────────────────────────────────────────────────────────

export function GenericApiConnectionModal({
  opened,
  onClose,
  workbookId,
  existingAccount,
  onConnectionCreated,
  onConnectionUpdated,
}: GenericApiConnectionModalProps) {
  const { createConnectorAccount, updateConnectorAccount } = useConnectorAccounts(workbookId);
  const isEditMode = !!existingAccount;

  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiType, setApiType] = useState<ApiType>('rest');
  const [authStyle, setAuthStyle] = useState<AuthStyleSelection>('bearer');
  const [customHeaderName, setCustomHeaderName] = useState('X-API-Key');
  const [restEndpoints, setRestEndpoints] = useState<GenericApiRestEndpoint[]>([blankRestEndpoint()]);
  const [graphqlEndpoints, setGraphqlEndpoints] = useState<GenericApiGraphqlEndpoint[]>([blankGraphqlEndpoint()]);
  const [userConfigured, setUserConfigured] = useState(false);

  const [manualOpen, setManualOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState<{ message: string; fixIt: string } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Prepopulate in edit mode
  useEffect(() => {
    if (!opened || !existingAccount) return;
    setDisplayName(existingAccount.displayName);
    setApiKey('');
    const extras = existingAccount.extras;
    if (isGenericApiConnectorExtras(extras)) {
      setApiType(extras.apiType);
      if (extras.authHeader.style === 'custom-header') {
        setAuthStyle('custom-header');
        setCustomHeaderName(extras.authHeader.headerName || 'X-API-Key');
      } else {
        setAuthStyle(extras.authHeader.style);
      }
      if (extras.apiType === 'rest') {
        setRestEndpoints(extras.endpoints as GenericApiRestEndpoint[]);
      } else {
        setGraphqlEndpoints(extras.endpoints as GenericApiGraphqlEndpoint[]);
      }
      setUserConfigured(true);
    }
  }, [existingAccount, opened]);

  const summary = useMemo(() => {
    type EndpointRow = { name: string; method?: string; url: string };
    let rows: EndpointRow[] = [];
    if (apiType === 'rest') {
      rows = restEndpoints
        .filter((e) => e.url.trim())
        .map((e, i) => ({ name: e.name?.trim() || `Endpoint ${i + 1}`, method: e.method, url: e.url.trim() }));
    } else {
      rows = graphqlEndpoints
        .filter((e) => e.url.trim() || e.query?.trim())
        .map((e, i) => ({ name: e.name?.trim() || `Endpoint ${i + 1}`, url: e.url.trim() }));
    }
    return {
      hasAnything: userConfigured,
      hasEndpoints: rows.length > 0,
      endpointCount: rows.length,
      endpointRows: rows,
      authLabel: describeAuth(authStyle, customHeaderName),
      apiTypeLabel: apiType === 'rest' ? 'REST' : 'GraphQL',
    };
  }, [apiType, restEndpoints, graphqlEndpoints, authStyle, customHeaderName, userConfigured]);

  const reset = () => {
    setDisplayName('');
    setApiKey('');
    setApiType('rest');
    setAuthStyle('bearer');
    setCustomHeaderName('X-API-Key');
    setRestEndpoints([blankRestEndpoint()]);
    setGraphqlEndpoints([blankGraphqlEndpoint()]);
    setUserConfigured(false);
    setManualOpen(false);
    setAiOpen(false);
    setPasteText('');
    setPasteError(null);
    setError(null);
  };

  const buildExtras = (): GenericApiConnectorExtras => {
    const authHeader: GenericApiConnectorExtras['authHeader'] =
      authStyle === 'custom-header'
        ? { style: 'custom-header', headerName: customHeaderName.trim() || 'X-API-Key' }
        : { style: authStyle };
    const endpoints: GenericApiConnectorExtras['endpoints'] =
      apiType === 'rest'
        ? restEndpoints.map((e) => ({
            ...e,
            url: e.url.trim(),
            name: e.name?.trim() || undefined,
            overrides: cleanOverrides(e.overrides),
          }))
        : graphqlEndpoints.map((e) => ({ ...e, url: e.url.trim(), name: e.name?.trim() || undefined }));
    return { apiType, authHeader, endpoints };
  };

  const validateForm = (): string | null => {
    if (!displayName.trim()) return 'Connection name is required.';
    if (!isEditMode && !apiKey.trim()) return 'API key is required.';
    if (!userConfigured) return 'Configure the connection (use AI or Edit manually).';
    if (authStyle === 'custom-header' && !customHeaderName.trim()) return 'Custom header name is required.';
    const endpoints = apiType === 'rest' ? restEndpoints : graphqlEndpoints;
    if (endpoints.length === 0) return 'Add at least one endpoint.';
    for (let i = 0; i < endpoints.length; i++) {
      const ep = endpoints[i];
      if (!ep.url.trim()) return `Endpoint ${i + 1} is missing a URL.`;
      try {
        new URL(ep.url.trim());
      } catch {
        return `Endpoint ${i + 1} URL is not a valid URL.`;
      }
      if (apiType === 'graphql' && !(ep as GenericApiGraphqlEndpoint).query.trim()) {
        return `Endpoint ${i + 1} is missing a GraphQL query.`;
      }
    }
    return null;
  };

  const buildAiPromptWithContext = (basePrompt: string): string => {
    if (!userConfigured) return basePrompt;
    const extras = buildExtras();
    const hasRealEndpoints = extras.endpoints.some((e) => e.url || (e as GenericApiGraphqlEndpoint).query);
    if (!hasRealEndpoints) return basePrompt;
    const contextBlock =
      `The user is **editing an existing Scratch connection**, not creating a new one. ` +
      `Their current configuration is below.\n\n` +
      `**Before you do anything else**, do this:\n` +
      `1. Read the existing JSON and give the user a short, friendly summary in plain ` +
      `English of what's currently set up (which API, which endpoints by name, and what ` +
      `auth header style). Two or three sentences max.\n` +
      `2. Ask the user what they want to change — add an endpoint, remove one, switch auth, ` +
      `replace everything, etc. Wait for their reply before producing any JSON.\n` +
      `3. When you do produce the updated JSON, keep every endpoint the user did NOT ` +
      `explicitly ask you to change or remove.\n\n` +
      `Current Scratch configuration:\n\n\`\`\`json\n${JSON.stringify(extras, null, 2)}\n\`\`\`\n\n` +
      `The workflow below tells you the JSON shape Scratch expects. Skip its "first message" ` +
      `step — you already have a service and a config; lead with the summary instead.\n\n---\n\n`;
    return contextBlock + basePrompt;
  };

  const handleGetAiPrompt = async () => {
    try {
      const { text } = await scratchApiClient.generic.getAiPrompt(apiType);
      await navigator.clipboard.writeText(buildAiPromptWithContext(text));
      notifications.show({
        title: 'AI prompt copied',
        message: userConfigured
          ? 'Paste it into your AI — your current endpoints are included so it can edit them.'
          : 'Paste it into ChatGPT, Claude, or any LLM, then come back with the response.',
        color: 'teal',
      });
    } catch (e) {
      notifications.show({
        title: 'Failed to copy AI prompt',
        message: e instanceof Error ? e.message : 'Unknown error',
        color: 'red',
      });
    }
  };

  const handlePasteApply = () => {
    setPasteError(null);
    const result = validatePastedConfig(pasteText, apiType);
    if (!result.ok) {
      setPasteError({ message: result.error.message, fixIt: result.error.fixItMessage });
      return;
    }
    const extras = result.extras;
    if (extras.authHeader.style === 'custom-header') {
      setAuthStyle('custom-header');
      setCustomHeaderName(extras.authHeader.headerName || 'X-API-Key');
    } else {
      setAuthStyle(extras.authHeader.style);
    }
    if (extras.apiType === 'rest') {
      setApiType('rest');
      setRestEndpoints(extras.endpoints as GenericApiRestEndpoint[]);
    } else {
      setApiType('graphql');
      setGraphqlEndpoints(extras.endpoints as GenericApiGraphqlEndpoint[]);
    }
    setUserConfigured(true);
    setAiOpen(false);
    setPasteText('');
    notifications.show({
      title: 'Config applied',
      message: `${extras.endpoints.length} endpoint${extras.endpoints.length === 1 ? '' : 's'} loaded.`,
      color: 'teal',
    });
  };

  const handleCopyFixIt = async () => {
    if (!pasteError) return;
    try {
      await navigator.clipboard.writeText(pasteError.fixIt);
      notifications.show({
        title: 'Fix-it message copied',
        message: 'Paste it back to your AI to regenerate the config.',
        color: 'teal',
      });
    } catch (e) {
      notifications.show({
        title: 'Failed to copy',
        message: e instanceof Error ? e.message : 'Unknown error',
        color: 'red',
      });
    }
  };

  const handleSave = async () => {
    const validationError = validateForm();
    if (validationError) {
      setError(validationError);
      return;
    }
    setError(null);
    setIsCreating(true);
    try {
      const extras = buildExtras() as unknown as Record<string, unknown>;
      if (isEditMode && existingAccount) {
        const trimmedKey = apiKey.trim();
        const updated = await updateConnectorAccount(existingAccount.id, {
          displayName: displayName.trim(),
          extras,
          ...(trimmedKey ? { userProvidedParams: { apiKey: trimmedKey } } : {}),
        });
        reset();
        onClose();
        onConnectionUpdated?.(updated);
      } else {
        const account = await createConnectorAccount({
          service: 'GENERIC_API',
          displayName: displayName.trim(),
          userProvidedParams: { apiKey: apiKey.trim() },
          extras,
        });
        reset();
        onClose();
        onConnectionCreated?.(account);
      }
    } catch (e) {
      const axiosMessage = (e as { response?: { data?: { message?: unknown } } })?.response?.data?.message;
      const msg = axiosMessage ?? (e instanceof Error ? e.message : 'Failed to save connection.');
      setError(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } finally {
      setIsCreating(false);
    }
  };

  const handleClose = () => {
    reset();
    onClose();
  };

  const anyChildOpen = manualOpen || aiOpen;

  return (
    <>
      <Modal
        opened={opened}
        onClose={handleClose}
        title={isEditMode ? 'Edit generic API connection' : 'Connect to a generic API'}
        size="lg"
        centered
        closeOnEscape={!anyChildOpen}
      >
        <Stack gap="md">
          {error && <Alert color="red">{error}</Alert>}

          <Group gap="xs" wrap="nowrap" align="center">
            <Text size="sm" w={80} style={{ flexShrink: 0 }}>
              Name
            </Text>
            <TextInput
              placeholder="e.g. Clover API"
              required
              value={displayName}
              onChange={(e) => setDisplayName(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
          </Group>
          <Group gap="xs" wrap="nowrap" align="center">
            <Text size="sm" w={80} style={{ flexShrink: 0 }}>
              API key
            </Text>
            <PasswordInput
              placeholder={isEditMode ? 'Leave blank to keep current key' : 'Pasted from your API provider'}
              required={!isEditMode}
              value={apiKey}
              onChange={(e) => setApiKey(e.currentTarget.value)}
              style={{ flex: 1 }}
            />
          </Group>

          <ConfigSummary summary={summary} onCopyJson={() => void copyConfigJson(buildExtras())} />

          <Group justify="center" gap="md" my="md">
            <ButtonSecondaryOutline
              onClick={() => {
                void handleGetAiPrompt().then(() => setAiOpen(true));
              }}
            >
              <Group gap={4} wrap="nowrap">
                <SparklesIcon size={14} /> {summary.hasEndpoints ? 'Edit Tables With AI' : 'Add Tables With AI'}
              </Group>
            </ButtonSecondaryOutline>
            <ButtonSecondaryOutline onClick={() => setManualOpen(true)}>
              {summary.hasEndpoints ? 'Edit Tables Manually' : 'Add Tables Manually'}
            </ButtonSecondaryOutline>
          </Group>

          <Group justify="flex-end" gap="sm">
            <ButtonSecondaryOutline onClick={handleClose}>Cancel</ButtonSecondaryOutline>
            <ButtonPrimaryLight onClick={() => void handleSave()} loading={isCreating}>
              {isEditMode ? 'Save changes' : 'Test & connect'}
            </ButtonPrimaryLight>
          </Group>
        </Stack>
      </Modal>

      <ManualEditorModal
        opened={manualOpen}
        onClose={() => setManualOpen(false)}
        apiType={apiType}
        setApiType={setApiType}
        authStyle={authStyle}
        setAuthStyle={setAuthStyle}
        customHeaderName={customHeaderName}
        setCustomHeaderName={setCustomHeaderName}
        restEndpoints={restEndpoints}
        setRestEndpoints={(next) => {
          setRestEndpoints(next);
          setUserConfigured(true);
        }}
        graphqlEndpoints={graphqlEndpoints}
        setGraphqlEndpoints={(next) => {
          setGraphqlEndpoints(next);
          setUserConfigured(true);
        }}
        onApplied={() => setUserConfigured(true)}
        markAuthChanged={() => setUserConfigured(true)}
      />

      <AiAssistModal
        opened={aiOpen}
        onClose={() => {
          setAiOpen(false);
          setPasteError(null);
        }}
        userConfigured={userConfigured}
        endpointsEmpty={isEndpointsEmpty(apiType, restEndpoints, graphqlEndpoints)}
        pasteText={pasteText}
        setPasteText={setPasteText}
        pasteError={pasteError}
        onGetPrompt={() => void handleGetAiPrompt()}
        onApply={handlePasteApply}
        onCopyFixIt={() => void handleCopyFixIt()}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Config summary
// ─────────────────────────────────────────────────────────────────────────────

interface ConfigSummaryProps {
  summary: {
    hasAnything: boolean;
    hasEndpoints: boolean;
    endpointCount: number;
    endpointRows: Array<{ name: string; method?: string; url: string }>;
    authLabel: string;
    apiTypeLabel: string;
  };
  onCopyJson: () => void;
}

function ConfigSummary({ summary, onCopyJson }: ConfigSummaryProps) {
  if (!summary.hasAnything) {
    return (
      <Alert color="gray" variant="light">
        <Text size="sm" c="dimmed">
          Connection not set up. Use the buttons below to configure endpoints.
        </Text>
      </Alert>
    );
  }
  return (
    <Stack
      gap={6}
      p="sm"
      style={{
        position: 'relative',
        border: '0.5px solid var(--mantine-color-gray-3)',
        borderRadius: 4,
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
      <Tooltip label="Copy config JSON" position="left">
        <ActionIcon variant="subtle" size="sm" onClick={onCopyJson} style={{ position: 'absolute', top: 6, right: 6 }}>
          <CopyIcon size={14} />
        </ActionIcon>
      </Tooltip>
      <Group gap="xs" wrap="nowrap">
        <Text size="xs" c="dimmed" w={80}>
          API style
        </Text>
        <Text size="sm">{summary.apiTypeLabel}</Text>
      </Group>
      <Group gap="xs" wrap="nowrap">
        <Text size="xs" c="dimmed" w={80}>
          Auth
        </Text>
        <Text size="sm">{summary.authLabel}</Text>
      </Group>
      <Group gap="xs" wrap="nowrap" align="flex-start" style={{ minWidth: 0 }}>
        <Text size="xs" c="dimmed" w={80} style={{ flexShrink: 0 }}>
          Endpoints
        </Text>
        {summary.hasEndpoints ? (
          <Stack gap={2} style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
            {summary.endpointRows.map((ep, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  gap: 'var(--mantine-spacing-xs)',
                  alignItems: 'center',
                  minWidth: 0,
                  overflow: 'hidden',
                }}
              >
                <Text
                  size="sm"
                  fw={500}
                  style={{
                    width: 140,
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={ep.name}
                >
                  {ep.name}
                </Text>
                <Text size="xs" c="dimmed" style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap' }} title={ep.url}>
                  {truncateMiddle(ep.url, URL_MAX_DISPLAY_CHARS)}
                </Text>
              </div>
            ))}
          </Stack>
        ) : (
          <Text size="sm" c="dimmed">
            no endpoints yet
          </Text>
        )}
      </Group>
    </Stack>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Manual editor modal
// ─────────────────────────────────────────────────────────────────────────────

interface ManualEditorProps {
  opened: boolean;
  onClose: () => void;
  apiType: ApiType;
  setApiType: (v: ApiType) => void;
  authStyle: AuthStyleSelection;
  setAuthStyle: (v: AuthStyleSelection) => void;
  customHeaderName: string;
  setCustomHeaderName: (v: string) => void;
  restEndpoints: GenericApiRestEndpoint[];
  setRestEndpoints: (next: GenericApiRestEndpoint[]) => void;
  graphqlEndpoints: GenericApiGraphqlEndpoint[];
  setGraphqlEndpoints: (next: GenericApiGraphqlEndpoint[]) => void;
  onApplied: () => void;
  markAuthChanged: () => void;
}

function ManualEditorModal({
  opened,
  onClose,
  apiType,
  setApiType,
  authStyle,
  setAuthStyle,
  customHeaderName,
  setCustomHeaderName,
  restEndpoints,
  setRestEndpoints,
  graphqlEndpoints,
  setGraphqlEndpoints,
  onApplied,
  markAuthChanged,
}: ManualEditorProps) {
  const [nestedOpen, setNestedOpen] = useState(0);
  const onNestedOpenChange = (open: boolean) => setNestedOpen((c) => Math.max(0, c + (open ? 1 : -1)));
  return (
    <Modal opened={opened} onClose={onClose} title="Edit endpoints manually" size="lg" closeOnEscape={nestedOpen === 0}>
      <Stack gap="md">
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            API style
          </Text>
          <SegmentedControl
            data={[
              { label: 'REST', value: 'rest' },
              { label: 'GraphQL', value: 'graphql' },
            ]}
            value={apiType}
            onChange={(v) => {
              setApiType(v as ApiType);
              markAuthChanged();
            }}
          />
        </Stack>

        <Select
          label="How to send the API key"
          data={AUTH_OPTIONS}
          value={authStyle}
          onChange={(v) => {
            if (v) {
              setAuthStyle(v as AuthStyleSelection);
              markAuthChanged();
            }
          }}
        />
        {authStyle === 'custom-header' && (
          <TextInput
            label="Custom header name"
            placeholder="X-API-Key"
            value={customHeaderName}
            onChange={(e) => {
              setCustomHeaderName(e.currentTarget.value);
              markAuthChanged();
            }}
          />
        )}

        <Text size="sm" fw={500}>
          Endpoints
        </Text>
        {apiType === 'rest' ? (
          <RestEndpointList
            endpoints={restEndpoints}
            onChange={setRestEndpoints}
            onNestedOpenChange={onNestedOpenChange}
          />
        ) : (
          <GraphqlEndpointList endpoints={graphqlEndpoints} onChange={setGraphqlEndpoints} />
        )}

        <Group justify="flex-end">
          <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
          <ButtonPrimaryLight
            onClick={() => {
              onApplied();
              onClose();
            }}
          >
            Done
          </ButtonPrimaryLight>
        </Group>
      </Stack>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// AI assist modal
// ─────────────────────────────────────────────────────────────────────────────

interface AiAssistProps {
  opened: boolean;
  onClose: () => void;
  userConfigured: boolean;
  endpointsEmpty: boolean;
  pasteText: string;
  setPasteText: (v: string) => void;
  pasteError: { message: string; fixIt: string } | null;
  onGetPrompt: () => void;
  onApply: () => void;
  onCopyFixIt: () => void;
}

function AiAssistModal({
  opened,
  onClose,
  userConfigured,
  endpointsEmpty,
  pasteText,
  setPasteText,
  pasteError,
  onGetPrompt,
  onApply,
  onCopyFixIt,
}: AiAssistProps) {
  return (
    <Modal opened={opened} onClose={onClose} title="Configure with AI" size="lg">
      <Stack gap="md">
        <Alert color="teal" variant="light">
          <Stack gap={4}>
            <Text size="sm">
              The prompt is in your clipboard. Paste it into ChatGPT, Claude, or any LLM — the agent will walk you
              through picking endpoints and return a JSON config.
              {userConfigured && !endpointsEmpty
                ? ' Your existing endpoints are included so the AI can edit or extend them.'
                : ''}
            </Text>
            <Group gap={4}>
              <Text
                component="button"
                type="button"
                size="xs"
                c="teal"
                td="underline"
                onClick={onGetPrompt}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}
              >
                Copy prompt again
              </Text>
            </Group>
          </Stack>
        </Alert>

        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Paste the AI&apos;s response below
          </Text>
          <Text size="xs" c="dimmed">
            Markdown fences and surrounding prose are OK — we extract the JSON.
          </Text>
          <Textarea
            minRows={8}
            autosize
            value={pasteText}
            onChange={(e) => setPasteText(e.currentTarget.value)}
            placeholder='{"authHeader":"Bearer", "endpoints":[...]}'
          />
          {pasteError && (
            <Alert color="red" title="Couldn't apply config">
              <Stack gap="xs">
                <Text size="sm">{pasteError.message}</Text>
                <ButtonSecondaryOutline onClick={onCopyFixIt}>Copy fix-it message</ButtonSecondaryOutline>
              </Stack>
            </Alert>
          )}
        </Stack>

        <Group justify="flex-end">
          <ButtonSecondaryOutline onClick={onClose}>Cancel</ButtonSecondaryOutline>
          <ButtonPrimaryLight onClick={onApply} disabled={!pasteText.trim()}>
            Apply config
          </ButtonPrimaryLight>
        </Group>
      </Stack>
    </Modal>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// REST endpoint list & rows
// ─────────────────────────────────────────────────────────────────────────────

interface RestListProps {
  endpoints: GenericApiRestEndpoint[];
  onChange: (next: GenericApiRestEndpoint[]) => void;
  onNestedOpenChange?: (open: boolean) => void;
}

function RestEndpointList({ endpoints, onChange, onNestedOpenChange }: RestListProps) {
  const update = (idx: number, patch: Partial<GenericApiRestEndpoint>) => {
    onChange(endpoints.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  };
  const remove = (idx: number) => onChange(endpoints.filter((_, i) => i !== idx));
  return (
    <Stack gap="xs">
      <Group gap="xs" wrap="nowrap" px={4}>
        <Text size="xs" c="dimmed" w={160} style={{ flexShrink: 0 }}>
          Name
        </Text>
        <Text size="xs" c="dimmed" style={{ flex: 1 }}>
          URL
        </Text>
        <div style={{ width: 64, flexShrink: 0 }} />
      </Group>
      {endpoints.map((ep, idx) => (
        <RestEndpointRow
          key={ep.id}
          endpoint={ep}
          removable={endpoints.length > 1}
          onChange={(patch) => update(idx, patch)}
          onRemove={() => remove(idx)}
          onSettingsOpenChange={onNestedOpenChange}
        />
      ))}
      <ButtonSecondaryOutline onClick={() => onChange([...endpoints, blankRestEndpoint()])}>
        <Group gap={4} wrap="nowrap">
          <PlusIcon size={14} /> Add endpoint
        </Group>
      </ButtonSecondaryOutline>
    </Stack>
  );
}

interface RestEndpointRowProps {
  endpoint: GenericApiRestEndpoint;
  removable: boolean;
  onChange: (patch: Partial<GenericApiRestEndpoint>) => void;
  onRemove: () => void;
  onSettingsOpenChange?: (open: boolean) => void;
}

function RestEndpointRow({ endpoint, removable, onChange, onRemove, onSettingsOpenChange }: RestEndpointRowProps) {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const openSettings = () => {
    setSettingsOpen(true);
    onSettingsOpenChange?.(true);
  };
  const closeSettings = () => {
    setSettingsOpen(false);
    onSettingsOpenChange?.(false);
  };
  const hasAdvanced = endpoint.method === 'POST' || !!endpoint.body || !!cleanOverrides(endpoint.overrides);
  return (
    <>
      <Group gap="xs" wrap="nowrap" align="center">
        <TextInput
          placeholder="Projects"
          value={endpoint.name ?? ''}
          onChange={(e) => onChange({ name: e.currentTarget.value })}
          w={160}
        />
        <TextInput
          placeholder="https://api.example.com/v1/projects?offset=0&limit=100"
          value={endpoint.url}
          onChange={(e) => onChange({ url: e.currentTarget.value })}
          style={{ flex: 1 }}
        />
        <Tooltip label={hasAdvanced ? 'Endpoint settings (customised)' : 'Endpoint settings'} position="top">
          <ActionIcon
            variant={hasAdvanced ? 'light' : 'subtle'}
            color={hasAdvanced ? 'blue' : undefined}
            onClick={openSettings}
          >
            <SettingsIcon size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Remove endpoint" position="left">
          <ActionIcon variant="subtle" color="red" onClick={onRemove} disabled={!removable}>
            <Trash2Icon size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <RestEndpointSettingsModal
        opened={settingsOpen}
        onClose={closeSettings}
        endpoint={endpoint}
        onChange={onChange}
      />
    </>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// REST endpoint settings modal (per-endpoint overrides)
// ─────────────────────────────────────────────────────────────────────────────

interface RestEndpointSettingsModalProps {
  opened: boolean;
  onClose: () => void;
  endpoint: GenericApiRestEndpoint;
  onChange: (patch: Partial<GenericApiRestEndpoint>) => void;
}

function RestEndpointSettingsModal({ opened, onClose, endpoint, onChange }: RestEndpointSettingsModalProps) {
  const overrides = endpoint.overrides ?? {};
  const request = overrides.request ?? {};
  const response = overrides.response ?? {};

  const patchOverrides = (patch: Partial<GenericApiEndpointOverrides>) => {
    onChange({ overrides: { ...overrides, ...patch } });
  };
  const patchRequest = (patch: Partial<NonNullable<GenericApiEndpointOverrides['request']>>) => {
    patchOverrides({ request: { ...request, ...patch } });
  };
  const patchResponse = (patch: Partial<NonNullable<GenericApiEndpointOverrides['response']>>) => {
    patchOverrides({ response: { ...response, ...patch } });
  };

  const title = endpoint.name?.trim() || endpoint.url || 'Endpoint';
  return (
    <Modal opened={opened} onClose={onClose} title={`Settings — ${title}`} size="md">
      <Stack gap="xs">
        <SettingsRow label="method">
          <SegmentedControl
            size="xs"
            data={['GET', 'POST']}
            value={endpoint.method}
            onChange={(v) => onChange({ method: v as 'GET' | 'POST' })}
          />
        </SettingsRow>
        <SettingsRow label="paginationType">
          <Select
            size="xs"
            data={[
              { value: '', label: 'auto-detect' },
              { value: 'cursor', label: 'cursor' },
              { value: 'offset', label: 'offset' },
              { value: 'graphql', label: 'graphql' },
              { value: 'link-header', label: 'link-header' },
              { value: 'none', label: 'none' },
            ]}
            value={overrides.paginationType ?? ''}
            onChange={(v) =>
              patchOverrides({ paginationType: (v || undefined) as GenericApiEndpointOverrides['paginationType'] })
            }
            style={{ flex: 1 }}
          />
        </SettingsRow>
        <SettingsRow label="maxPages">
          <NumberInput
            size="xs"
            value={overrides.maxPages ?? ''}
            onChange={(v) => patchOverrides({ maxPages: typeof v === 'number' ? v : undefined })}
            placeholder="1000"
            min={1}
            style={{ flex: 1 }}
          />
        </SettingsRow>
        <SettingsRow label="enrichUrl">
          <TextInput
            size="xs"
            value={overrides.enrichUrl ?? ''}
            onChange={(e) => patchOverrides({ enrichUrl: e.currentTarget.value || undefined })}
            placeholder="/v1/projects/{id}"
            style={{ flex: 1 }}
          />
        </SettingsRow>

        <Divider label="request" labelPosition="left" my={4} />
        <SettingsRow label="cursorParam">
          <TextInput
            size="xs"
            value={request.cursorParam ?? ''}
            onChange={(e) => patchRequest({ cursorParam: e.currentTarget.value || undefined })}
            placeholder="cursor"
            style={{ flex: 1 }}
          />
        </SettingsRow>
        <SettingsRow label="offsetParam">
          <TextInput
            size="xs"
            value={request.offsetParam ?? ''}
            onChange={(e) => patchRequest({ offsetParam: e.currentTarget.value || undefined })}
            placeholder="offset"
            style={{ flex: 1 }}
          />
        </SettingsRow>
        <SettingsRow label="limitParam">
          <TextInput
            size="xs"
            value={request.limitParam ?? ''}
            onChange={(e) => patchRequest({ limitParam: e.currentTarget.value || undefined })}
            placeholder="limit"
            style={{ flex: 1 }}
          />
        </SettingsRow>
        <SettingsRow label="maxPageSize">
          <NumberInput
            size="xs"
            value={request.maxPageSize ?? ''}
            onChange={(v) => patchRequest({ maxPageSize: typeof v === 'number' ? v : undefined })}
            placeholder="100"
            min={1}
            style={{ flex: 1 }}
          />
        </SettingsRow>

        <Divider label="response" labelPosition="left" my={4} />
        <SettingsRow label="dataPath">
          <TextInput
            size="xs"
            value={response.dataPath ?? ''}
            onChange={(e) => patchResponse({ dataPath: e.currentTarget.value || undefined })}
            placeholder="data"
            style={{ flex: 1 }}
          />
        </SettingsRow>
        <SettingsRow label="cursorPath">
          <TextInput
            size="xs"
            value={response.cursorPath ?? ''}
            onChange={(e) => patchResponse({ cursorPath: e.currentTarget.value || undefined })}
            placeholder="next_cursor"
            style={{ flex: 1 }}
          />
        </SettingsRow>
        <SettingsRow label="idPath">
          <TextInput
            size="xs"
            value={response.idPath ?? ''}
            onChange={(e) => patchResponse({ idPath: e.currentTarget.value || undefined })}
            placeholder="id"
            style={{ flex: 1 }}
          />
        </SettingsRow>

        <Group justify="flex-end" mt="sm">
          <ButtonPrimaryLight onClick={onClose}>Done</ButtonPrimaryLight>
        </Group>
      </Stack>
    </Modal>
  );
}

function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group gap="xs" wrap="nowrap" align="center">
      <Text size="xs" c="dimmed" w={120} ff="monospace" style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </Group>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// GraphQL endpoint list
// ─────────────────────────────────────────────────────────────────────────────

interface GraphqlListProps {
  endpoints: GenericApiGraphqlEndpoint[];
  onChange: (next: GenericApiGraphqlEndpoint[]) => void;
}

function GraphqlEndpointList({ endpoints, onChange }: GraphqlListProps) {
  const update = (idx: number, patch: Partial<GenericApiGraphqlEndpoint>) => {
    onChange(endpoints.map((e, i) => (i === idx ? { ...e, ...patch } : e)));
  };
  return (
    <Stack gap="xs">
      {endpoints.map((ep, idx) => (
        <Stack
          key={ep.id}
          gap={6}
          p="sm"
          style={{ border: '0.5px solid var(--mantine-color-gray-3)', borderRadius: 4 }}
        >
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <TextInput
              label={idx === 0 ? 'GraphQL endpoint URL' : undefined}
              placeholder="https://api.example.com/graphql"
              value={ep.url}
              onChange={(e) => update(idx, { url: e.currentTarget.value })}
              style={{ flex: 1 }}
            />
            <Tooltip label="Remove endpoint" position="left">
              <ActionIcon
                variant="subtle"
                color="red"
                onClick={() => onChange(endpoints.filter((_, i) => i !== idx))}
                disabled={endpoints.length === 1}
              >
                <Trash2Icon size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <TextInput
            placeholder="Display name (optional)"
            value={ep.name ?? ''}
            onChange={(e) => update(idx, { name: e.currentTarget.value })}
            size="xs"
          />
          <Textarea
            label="GraphQL query"
            placeholder="query Issues($after: String) { issues(after: $after) { nodes { id } pageInfo { endCursor hasNextPage } } }"
            minRows={4}
            autosize
            value={ep.query}
            onChange={(e) => update(idx, { query: e.currentTarget.value })}
          />
        </Stack>
      ))}
      <ButtonSecondaryOutline onClick={() => onChange([...endpoints, blankGraphqlEndpoint()])}>
        <Group gap={4} wrap="nowrap">
          <PlusIcon size={14} /> Add endpoint
        </Group>
      </ButtonSecondaryOutline>
    </Stack>
  );
}
