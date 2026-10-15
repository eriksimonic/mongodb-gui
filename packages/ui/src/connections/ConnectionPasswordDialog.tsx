import { Alert, Button, Group, Modal, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useAppStore } from '../state/app-store-context';
import { errorText } from '../kit/notify-error';
import {
  useConnectionPasswordStore,
  type ConnectionPasswordRequest,
} from './connection-password-store';

/** Mounted once in the shell. Opens when a saved connection's server rejects its credentials. */
export function ConnectionPasswordDialog() {
  const request = useConnectionPasswordStore((state) => state.request);
  const close = useConnectionPasswordStore((state) => state.close);
  if (request === undefined) {
    return null;
  }
  return <ConnectionPasswordForm key={request.connectionId} request={request} onClose={close} />;
}

interface ConnectionPasswordFormProps {
  readonly request: ConnectionPasswordRequest;
  readonly onClose: () => void;
}

function ConnectionPasswordForm({ request, onClose }: ConnectionPasswordFormProps) {
  const connectWithPassword = useAppStore((state) => state.connectWithPassword);
  const [username, setUsername] = useState(request.username);
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const canSubmit = username !== '' && password !== '' && !submitting;

  async function submit() {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await connectWithPassword(request.connectionId, { username, password });
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal opened onClose={onClose} title={`Connect to ${request.connectionName}`} centered>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <Text size="sm">
            The server needs a password for this connection. It is saved with the connection once
            the server accepts it.
          </Text>
          <TextInput
            label="Username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value)}
          />
          <PasswordInput
            label="Password"
            autoComplete="current-password"
            data-autofocus
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
          {error === undefined ? null : (
            <Alert color="red" title="Could not connect">
              {error}
            </Alert>
          )}
          <Group justify="flex-end">
            <Button variant="default" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} loading={submitting}>
              Connect
            </Button>
          </Group>
        </Stack>
      </form>
    </Modal>
  );
}
