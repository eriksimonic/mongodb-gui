import {
  Alert,
  Box,
  Button,
  Code,
  ColorInput,
  Group,
  Loader,
  Modal,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { redactUri, toAppError, type ConnectionTestResult } from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { useAppStore } from '../../state/app-store-context';
import { ConnectionForm } from './ConnectionForm';
import {
  createDraft,
  draftInput,
  switchDraftMode,
  validateDraft,
  type ConnectionDraft,
  type DraftMode,
} from './connection-draft';

const SWATCHES = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#14b8a6'];

export interface ConnectionDialogProps {
  /** Undefined creates a new connection. A value loads that connection for editing. */
  readonly connectionId?: string | undefined;
  readonly initialMode?: DraftMode;
  readonly onClose: () => void;
}

/** One line under the buttons. Tone is green for success and red for a problem. */
interface StatusLine {
  readonly tone: 'green' | 'red';
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

  function describeTest(result: ConnectionTestResult): StatusLine {
    if (result.ok) {
      return {
        tone: 'green',
        text: `Connected. Server ${result.serverVersion}, ${result.topology}.`,
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
    try {
      setStatus(describeTest(await testConnection(draftInput(current))));
    } catch (error) {
      setStatus(describeTest({ ok: false, error: toAppError(error) }));
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
      notifications.show({ color: 'green', message: 'Connection saved' });
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
        <Stack gap="sm">
          {dockerManaged ? (
            <Alert color="blue" variant="light">
              The host and port of a Docker connection are managed by the app. The URI is rebuilt on
              every connect, so edits to the host and port are replaced. Name, colour and options
              stay editable.
            </Alert>
          ) : null}
          <Group align="flex-end" wrap="nowrap">
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
              value={draft.color}
              eyeDropperButtonProps={{ 'aria-label': 'Pick colour' }}
              onChange={(value) => updateDraft({ ...draft, color: value })}
            />
          </Group>
          <SegmentedControl
            aria-label="Connection string mode"
            value={draft.mode}
            onChange={(value) => changeMode(value === 'form' ? 'form' : 'uri')}
            data={[
              { label: 'URI', value: 'uri' },
              { label: 'Form', value: 'form' },
            ]}
          />
          {draft.mode === 'uri' ? (
            <Stack gap={4}>
              <Textarea
                label="Connection URI"
                autosize
                minRows={2}
                value={draft.uri}
                onChange={(event) => updateDraft({ ...draft, uri: event.currentTarget.value })}
              />
              <Text size="xs" c="dimmed">
                Preview with the password hidden
              </Text>
              <Code block>{redactUri(draft.uri)}</Code>
            </Stack>
          ) : (
            <ConnectionForm
              form={draft.form}
              onChange={(patch) => updateDraft({ ...draft, form: { ...draft.form, ...patch } })}
            />
          )}
          <Group justify="space-between" wrap="nowrap" gap="sm">
            <Group gap="sm" wrap="nowrap" style={{ flex: 1, minWidth: 0 }}>
              <Button variant="default" loading={testing} onClick={() => void handleTest(draft)}>
                Test connection
              </Button>
              <StatusText status={status} />
            </Group>
            <Group gap="xs" wrap="nowrap">
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

/** Fixed-height line beside the buttons, so a result never shifts the layout. */
function StatusText({ status }: { readonly status: StatusLine | undefined }) {
  return (
    <Box h={18} style={{ flex: 1, minWidth: 0 }}>
      <Text
        size="xs"
        role="status"
        c={status === undefined ? 'dimmed' : status.tone}
        truncate="end"
      >
        {status?.text ?? ''}
      </Text>
    </Box>
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
