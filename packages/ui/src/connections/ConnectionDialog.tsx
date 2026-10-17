import {
  Alert,
  Badge,
  Button,
  Code,
  ColorInput,
  ColorSwatch,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { IconAlertCircle, IconCheck } from '@tabler/icons-react';
import { notifications } from '@mantine/notifications';
import { redactUri, toAppError, type ConnectionTestResult } from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import { useAppStore } from '../state/app-store-context';
import { ConnectionForm } from './ConnectionForm';
import {
  createDraft,
  draftInput,
  switchDraftMode,
  validateDraft,
  type ConnectionDraft,
  type DraftMode,
} from './connection-draft';
import { parseMongoUri } from './uri-form';

const SWATCHES = [
  '#6aa5ff',
  '#f4b223',
  '#f2597f',
  '#4cc38a',
  '#a98bfa',
  '#3cc9b5',
  '#f08a3c',
  '#a19d96',
];

export interface ConnectionDialogProps {
  /** Undefined creates a new connection. A value loads that connection for editing. */
  readonly connectionId?: string | undefined;
  readonly initialMode?: DraftMode;
  readonly onClose: () => void;
}

/** One line under the buttons. Tone is blue for success and red for a problem. */
interface StatusLine {
  readonly tone: 'blue' | 'red';
  readonly text: string;
}

/** Create or edit a connection in URI mode or Form mode. Both modes edit the same draft. */
export function ConnectionDialog({
  connectionId,
  initialMode = 'uri',
  onClose,
}: ConnectionDialogProps) {
  const { rpc } = useUiApi();
  const createConnection = useAppStore((state) => state.createConnection);
  const updateConnection = useAppStore((state) => state.updateConnection);
  const testConnection = useAppStore((state) => state.testConnection);
  const [draft, setDraft] = useState<ConnectionDraft | undefined>(() =>
    connectionId === undefined ? createDraft(initialMode) : undefined,
  );
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<StatusLine | undefined>(undefined);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dockerManaged, setDockerManaged] = useState(false);

  useEffect(() => {
    if (connectionId === undefined) {
      return undefined;
    }
    let active = true;
    rpc.connections.get({ id: connectionId }).then(
      (profile) => {
        if (active) {
          setDockerManaged(profile.source === 'docker');
          setDraft(createDraft(initialMode, profile));
        }
      },
      (error: unknown) => {
        if (active) {
          setLoadError(toAppError(error).message);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, connectionId, initialMode]);

  function updateDraft(next: ConnectionDraft) {
    setDraft(next);
    setStatus(undefined);
  }

  function changeMode(mode: DraftMode) {
    if (draft === undefined) {
      return;
    }
    const result = switchDraftMode(draft, mode);
    if (result.ok) {
      setStatus(undefined);
      setDraft(result.draft);
    } else {
      setStatus({ tone: 'red', text: result.message });
    }
  }

  function describeTest(result: ConnectionTestResult, elapsedMs: number): StatusLine {
    if (result.ok) {
      return {
        tone: 'blue',
        text: `Connected in ${elapsedMs} ms. Server ${result.serverVersion}, ${result.topology}.`,
      };
    }
    const detail = result.error.detail === undefined ? '' : ` (${result.error.detail})`;
    return { tone: 'red', text: `${result.error.message}${detail}` };
  }

  async function handleTest(current: ConnectionDraft) {
    const problem = validateDraft(current);
    if (problem !== undefined) {
      setStatus({ tone: 'red', text: problem });
      return;
    }
    setTesting(true);
    setStatus(undefined);
    const started = Date.now();
    try {
      const result = await testConnection(draftInput(current));
      setStatus(describeTest(result, Date.now() - started));
    } catch (error) {
      setStatus(describeTest({ ok: false, error: toAppError(error) }, Date.now() - started));
    } finally {
      setTesting(false);
    }
  }

  async function handleSave(current: ConnectionDraft) {
    const problem = validateDraft(current);
    if (problem !== undefined) {
      setStatus({ tone: 'red', text: problem });
      return;
    }
    setSaving(true);
    setStatus(undefined);
    try {
      const input = draftInput(current);
      if (connectionId === undefined) {
        await createConnection(input);
      } else {
        await updateConnection(connectionId, input);
      }
      notifications.show({ color: 'blue', message: 'Connection saved' });
      onClose();
    } catch (error) {
      setStatus({ tone: 'red', text: toAppError(error).message });
      setSaving(false);
    }
  }

  const title = connectionId === undefined ? 'New connection' : 'Edit connection';

  return (
    <Modal
      opened
      onClose={onClose}
      title={title}
      size={640}
      centered
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      {draft === undefined ? (
        <DialogLoading message={loadError} />
      ) : (
        <Stack gap="lg">
          {dockerManaged ? (
            <Alert color="blue" variant="light">
              The host and port of a Docker connection are managed by the app. The URI is rebuilt on
              every connect, so edits to the host and port are replaced. Name, colour and options
              stay editable.
            </Alert>
          ) : null}
          <Group align="flex-end" wrap="nowrap" gap="lg">
            <TextInput
              label="Name"
              value={draft.name}
              onChange={(event) => updateDraft({ ...draft, name: event.currentTarget.value })}
              style={{ flex: 1 }}
              autoFocus
            />
            <ColorInput
              label="Colour"
              format="hex"
              w={150}
              swatches={SWATCHES}
              leftSection={
                <ColorSwatch color={draft.color === '' ? 'transparent' : draft.color} size={14} />
              }
              value={draft.color}
              eyeDropperButtonProps={{ 'aria-label': 'Pick colour' }}
              onChange={(value) => updateDraft({ ...draft, color: value })}
            />
          </Group>
          <SegmentedControl
            fullWidth
            styles={{
              root: { height: 30 },
              control: { height: 28 },
              label: { padding: '0 12px', lineHeight: '26px' },
            }}
            aria-label="Connection string mode"
            value={draft.mode}
            onChange={(value) => changeMode(value === 'form' ? 'form' : 'uri')}
            data={[
              { label: 'URI', value: 'uri' },
              { label: 'Form', value: 'form' },
            ]}
          />
          {draft.mode === 'uri' ? (
            <Stack gap="sm">
              <Textarea
                label="Connection URI"
                autosize
                minRows={2}
                value={draft.uri}
                styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
                onChange={(event) => updateDraft({ ...draft, uri: event.currentTarget.value })}
              />
              <Text size="xs" c="dimmed">
                Paste a mongodb:// or mongodb+srv:// string. The password is masked and saved
                encrypted.
              </Text>
              <UriChips uri={draft.uri} />
              <Text size="xs" c="dimmed">
                Preview with the password hidden
              </Text>
              <Code block bg="var(--mg-bg-sunken)">
                {redactUri(draft.uri)}
              </Code>
            </Stack>
          ) : (
            <ConnectionForm
              form={draft.form}
              onChange={(patch) => updateDraft({ ...draft, form: { ...draft.form, ...patch } })}
            />
          )}
          {status?.tone === 'blue' ? (
            <Group
              gap="xs"
              wrap="nowrap"
              px="sm"
              py={8}
              role="status"
              style={{
                borderRadius: 6,
                color: 'var(--mg-ok)',
                background: 'color-mix(in srgb, var(--mg-ok) 14%, var(--mg-surface-1))',
              }}
            >
              <IconCheck size={16} />
              <Text size="sm">{status.text}</Text>
            </Group>
          ) : null}
          {status?.tone === 'red' ? (
            <Group
              gap="xs"
              wrap="nowrap"
              align="flex-start"
              px="sm"
              py={8}
              role="alert"
              style={{
                borderRadius: 6,
                color: 'var(--mg-danger)',
                background: 'color-mix(in srgb, var(--mg-danger) 14%, var(--mg-surface-1))',
              }}
            >
              <IconAlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                {status.text}
              </Text>
            </Group>
          ) : null}
          <Group justify="space-between" wrap="nowrap" gap="sm" align="center" mt="lg">
            <Group gap="sm" wrap="nowrap">
              <Button variant="default" loading={testing} onClick={() => void handleTest(draft)}>
                Test connection
              </Button>
            </Group>
            <Group gap="sm" wrap="nowrap">
              <Button variant="default" onClick={onClose}>
                Cancel
              </Button>
              <Button loading={saving} onClick={() => void handleSave(draft)}>
                Save
              </Button>
            </Group>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}

function DialogLoading({ message }: { readonly message: string | undefined }) {
  if (message !== undefined) {
    return (
      <Alert color="red" variant="light">
        {message}
      </Alert>
    );
  }
  return (
    <Group justify="center" py="md">
      <Loader size="sm" aria-label="Loading connection" />
    </Group>
  );
}

/** What the URI parser found, as chips under the textarea. Shows the parse error when the URI is invalid. */
function UriChips({ uri }: { readonly uri: string }) {
  const parsed = parseMongoUri(uri);
  const chips: string[] = [];
  if (parsed.ok) {
    const { form } = parsed;
    chips.push(
      form.scheme === 'mongodb+srv'
        ? `SRV \u00b7 ${form.hosts[0] ?? ''}`
        : `${form.hosts.length} ${form.hosts.length === 1 ? 'host' : 'hosts'}`,
    );
    if (form.username !== '') {
      chips.push(`User ${form.username}`);
    }
    if (form.database !== '') {
      chips.push(`Database ${form.database}`);
    }
    if (form.readPreference !== undefined) {
      chips.push(form.readPreference);
    }
    if (form.tls.enabled) {
      chips.push('TLS on');
    } else if (form.scheme === 'mongodb+srv') {
      chips.push('TLS on, implied by SRV');
    }
  }
  return (
    <Group gap="md">
      {parsed.ok ? (
        <Badge variant="outline" color="green" leftSection={<IconCheck size={12} />}>
          Valid
        </Badge>
      ) : (
        <Badge variant="outline" color="red" leftSection={<IconAlertCircle size={12} />}>
          {parsed.message}
        </Badge>
      )}
      {chips.map((chip) => (
        <Badge key={chip} variant="default" tt="none" fw={400}>
          {chip}
        </Badge>
      ))}
    </Group>
  );
}
