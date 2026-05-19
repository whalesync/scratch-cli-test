import { ButtonPrimaryLight, ButtonSecondaryOutline } from '@/app/components/base/buttons';
import { ModalWrapper } from '@/app/components/ModalWrapper';
import { ScratchpadNotifications } from '@/app/components/ScratchpadNotifications';
import { useConnectorAccounts } from '@/hooks/use-connector-account';
import { genericApiApi } from '@/lib/api/generic-api';
import { ScratchpadApiError } from '@/lib/api/error';
import {
  ActionIcon,
  Alert,
  Group,
  Modal,
  ModalProps,
  PasswordInput,
  SegmentedControl,
  Select,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from '@mantine/core';
import {
  ConnectorAccount,
  GenericApiConnectorExtras,
  GenericApiGraphqlEndpoint,
  GenericApiRestEndpoint,
  isGenericApiConnectorExtras,
  validatePastedConfig,
} from '@spinner/shared-types';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

export type GenericApiConnectionModalProps = ModalProps & {
  workbookId: string;
  /** When set, the modal runs in edit mode: prepopulates from this account and PATCHes on save. */
  existingAccount?: ConnectorAccount | null;
  onConnectionCreated?: (account: ConnectorAccount) => void;
  onConnectionUpdated?: (account: ConnectorAccount) => void;
};

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

// Are the endpoints purely placeholder (initial blank rows)?
const isEndpointsEmpty = (apiType: ApiType, rest: GenericApiRestEndpoint[], gql: GenericApiGraphqlEndpoint[]) => {
  const list = apiType === 'rest' ? rest : gql;
  return list.every((e) => !e.url.trim() && !(e as GenericApiGraphqlEndpoint).query?.trim());
};

const URL_MAX_DISPLAY_CHARS = 50;
const truncateMiddle = (s: string, max: number): string => {
  if (s.length <= max) return s;
  // Keep the start (host + path-ish) and the very end (often a useful identifier).
  const headLen = Math.ceil((max - 1) * 0.75);
  const tailLen = max - 1 - headLen;
  return s.slice(0, headLen) + '…' + (tailLen > 0 ? s.slice(s.length - tailLen) : '');
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

export const GenericApiConnectionModal = (props: GenericApiConnectionModalProps) => {
  const { workbookId, existingAccount, onConnectionCreated, onConnectionUpdated, ...modalProps } = props;
  const { createConnectorAccount, updateConnectorAccount } = useConnectorAccounts(workbookId);
  const isEditMode = !!existingAccount;

  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [apiType, setApiType] = useState<ApiType>('rest');
  const [authStyle, setAuthStyle] = useState<AuthStyleSelection>('bearer');
  const [customHeaderName, setCustomHeaderName] = useState('X-API-Key');
  const [restEndpoints, setRestEndpoints] = useState<GenericApiRestEndpoint[]>([blankRestEndpoint()]);
  const [graphqlEndpoints, setGraphqlEndpoints] = useState<GenericApiGraphqlEndpoint[]>([blankGraphqlEndpoint()]);

  // Has the user touched anything beyond the initial blank state?
  // We track explicitly because a blank "row" still counts as a non-empty array.
  const [userConfigured, setUserConfigured] = useState(false);

  const [manualOpen, setManualOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState<{ message: string; fixIt: string } | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Prepopulate from an existing account when in edit mode. Triggered whenever
  // the modal opens with a different account so re-opens reset cleanly.
  useEffect(() => {
    if (!existingAccount) return;
    setDisplayName(existingAccount.displayName);
    setApiKey(''); // blank = keep existing encrypted key
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
  }, [existingAccount]);

  const summary = useMemo(() => {
    type EndpointRow = { name: string; method?: string; url: string };
    let rows: EndpointRow[] = [];
    if (apiType === 'rest') {
      rows = restEndpoints
        .filter((e) => e.url.trim())
        .map((e, i) => ({
          name: e.name?.trim() || `Endpoint ${i + 1}`,
          method: e.method,
          url: e.url.trim(),
        }));
    } else {
      rows = graphqlEndpoints
        .filter((e) => e.url.trim() || e.query?.trim())
        .map((e, i) => ({
          name: e.name?.trim() || `Endpoint ${i + 1}`,
          url: e.url.trim(),
        }));
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
        ? restEndpoints.map((e) => ({ ...e, url: e.url.trim(), name: e.name?.trim() || undefined }))
        : graphqlEndpoints.map((e) => ({ ...e, url: e.url.trim(), name: e.name?.trim() || undefined }));
    return { apiType, authHeader, endpoints };
  };

  const validateForm = (): string | null => {
    if (!displayName.trim()) return 'Connection name is required.';
    // In edit mode the existing apiKey is preserved when blank — only create requires it.
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

  // Build the prompt to copy. If the user already has endpoints, prepend a
  // context block so the AI edits/extends rather than starting over.
  const buildAiPromptWithContext = (basePrompt: string): string => {
    if (!userConfigured) return basePrompt;
    const extras = buildExtras();
    const hasRealEndpoints = extras.endpoints.some(
      (e) => e.url || (e as GenericApiGraphqlEndpoint).query,
    );
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
      const { text } = await genericApiApi.getAiPrompt(apiType);
      await navigator.clipboard.writeText(buildAiPromptWithContext(text));
      ScratchpadNotifications.success({
        title: 'AI prompt copied',
        message: userConfigured
          ? 'Paste it into your AI — your current endpoints are included so it can edit them.'
          : 'Paste it into ChatGPT, Claude, or any LLM, then come back with the response.',
      });
    } catch (e) {
      ScratchpadNotifications.error({
        title: 'Failed to copy AI prompt',
        message: e instanceof Error ? e.message : 'Unknown error',
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
    ScratchpadNotifications.success({
      title: 'Config applied',
      message: `${extras.endpoints.length} endpoint${extras.endpoints.length === 1 ? '' : 's'} loaded.`,
    });
  };

  const handleCopyFixIt = async () => {
    if (!pasteError) return;
    try {
      await navigator.clipboard.writeText(pasteError.fixIt);
      ScratchpadNotifications.success({
        title: 'Fix-it message copied',
        message: 'Paste it back to your AI to regenerate the config.',
      });
    } catch (e) {
      ScratchpadNotifications.error({
        title: 'Failed to copy',
        message: e instanceof Error ? e.message : 'Unknown error',
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
          // Only send userProvidedParams when the user typed a new key — blank means "keep existing".
          ...(trimmedKey ? { userProvidedParams: { apiKey: trimmedKey } } : {}),
        });
        reset();
        props.onClose?.();
        onConnectionUpdated?.(updated);
      } else {
        const account = await createConnectorAccount({
          service: 'GENERIC_API',
          displayName: displayName.trim(),
          userProvidedParams: { apiKey: apiKey.trim() },
          extras,
        });
        reset();
        props.onClose?.();
        onConnectionCreated?.(account);
      }
    } catch (e) {
      if (e instanceof ScratchpadApiError) {
        setError(e.message);
      } else {
        setError(e instanceof Error ? e.message : 'Failed to save connection.');
      }
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <ModalWrapper
      title={isEditMode ? 'Edit generic API connection' : 'Connect to a generic API'}
      customProps={{
        footer: (
          <>
            <ButtonSecondaryOutline onClick={props.onClose}>Cancel</ButtonSecondaryOutline>
            <ButtonPrimaryLight onClick={handleSave} loading={isCreating}>
              {isEditMode ? 'Save changes' : 'Test & connect'}
            </ButtonPrimaryLight>
          </>
        ),
      }}
      {...modalProps}
      onExitTransitionEnd={reset}
    >
      <Stack gap="md">
        {error && <Alert color="red">{error}</Alert>}

        <TextInput
          label="Connection name"
          placeholder="e.g. Clover API"
          required
          value={displayName}
          onChange={(e) => setDisplayName(e.currentTarget.value)}
        />

        <PasswordInput
          label="API key"
          placeholder={isEditMode ? 'Leave blank to keep current key' : 'Pasted from your API provider'}
          description={isEditMode ? 'Type a new key only if you want to replace the stored one.' : undefined}
          required={!isEditMode}
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
        />

        <Group justify="center" gap="md" my="md">
          <ButtonSecondaryOutline
            onClick={async () => {
              await handleGetAiPrompt();
              setAiOpen(true);
            }}
          >
            <Group gap={4} wrap="nowrap">
              <Sparkles size={14} /> {summary.hasEndpoints ? 'Edit Tables With AI' : 'Add Tables With AI'}
            </Group>
          </ButtonSecondaryOutline>
          <ButtonSecondaryOutline onClick={() => setManualOpen(true)}>
            {summary.hasEndpoints ? 'Edit Tables Manually' : 'Add Tables Manually'}
          </ButtonSecondaryOutline>
        </Group>

        <ConfigSummary summary={summary} />
      </Stack>

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
        onGetPrompt={handleGetAiPrompt}
        onApply={handlePasteApply}
        onCopyFixIt={handleCopyFixIt}
      />
    </ModalWrapper>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// Read-only config summary shown in the main modal.
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
}

const ConfigSummary = ({ summary }: ConfigSummaryProps) => {
  if (!summary.hasAnything) {
    return (
      <Alert color="gray" variant="light">
        <Text size="sm" c="dimmed">
          Connection not set up. Use the buttons above to configure endpoints.
        </Text>
      </Alert>
    );
  }
  return (
    <Stack
      gap={6}
      p="sm"
      style={{
        border: '0.5px solid var(--mantine-color-gray-3)',
        borderRadius: 4,
        minWidth: 0,
        overflow: 'hidden',
      }}
    >
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
                <Text size="sm" fw={500} style={{ flexShrink: 0 }}>
                  {ep.name}
                </Text>
                {ep.method && (
                  <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
                    {ep.method}
                  </Text>
                )}
                <Text
                  size="xs"
                  c="dimmed"
                  style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap' }}
                  title={ep.url}
                >
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
};

// ─────────────────────────────────────────────────────────────────────────────
// Manual editor (second modal).
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

const ManualEditorModal = ({
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
}: ManualEditorProps) => {
  return (
    <Modal opened={opened} onClose={onClose} title="Edit endpoints manually" size="lg">
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
          <RestEndpointList endpoints={restEndpoints} onChange={setRestEndpoints} />
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
};

// ─────────────────────────────────────────────────────────────────────────────
// AI assist modal — copy prompt + paste response.
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

const AiAssistModal = ({
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
}: AiAssistProps) => {
  return (
    <Modal opened={opened} onClose={onClose} title="Configure with AI" size="lg">
      <Stack gap="md">
        <Alert color="teal" variant="light">
          <Stack gap={4}>
            <Text size="sm">
              The prompt is in your clipboard. Paste it into ChatGPT, Claude, or any LLM — the
              agent will walk you through picking endpoints and return a JSON config.
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
};

// ─────────────────────────────────────────────────────────────────────────────
// Endpoint editors.
// ─────────────────────────────────────────────────────────────────────────────

interface RestListProps {
  endpoints: GenericApiRestEndpoint[];
  onChange: (next: GenericApiRestEndpoint[]) => void;
}

const RestEndpointList = ({ endpoints, onChange }: RestListProps) => {
  const update = (idx: number, patch: Partial<GenericApiRestEndpoint>) => {
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
            <Select
              label={idx === 0 ? 'Method' : undefined}
              data={['GET', 'POST']}
              value={ep.method}
              onChange={(v) => v && update(idx, { method: v as 'GET' | 'POST' })}
              w={90}
            />
            <TextInput
              label={idx === 0 ? 'URL' : undefined}
              placeholder="https://api.example.com/v1/projects"
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
                <Trash2 size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
          <TextInput
            placeholder="Display name (optional — derived from path if blank)"
            value={ep.name ?? ''}
            onChange={(e) => update(idx, { name: e.currentTarget.value })}
            size="xs"
          />
        </Stack>
      ))}
      <ButtonSecondaryOutline onClick={() => onChange([...endpoints, blankRestEndpoint()])}>
        <Group gap={4} wrap="nowrap">
          <Plus size={14} /> Add endpoint
        </Group>
      </ButtonSecondaryOutline>
    </Stack>
  );
};

interface GraphqlListProps {
  endpoints: GenericApiGraphqlEndpoint[];
  onChange: (next: GenericApiGraphqlEndpoint[]) => void;
}

const GraphqlEndpointList = ({ endpoints, onChange }: GraphqlListProps) => {
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
                <Trash2 size={14} />
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
          <Plus size={14} /> Add endpoint
        </Group>
      </ButtonSecondaryOutline>
    </Stack>
  );
};
