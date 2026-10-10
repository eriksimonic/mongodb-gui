import { Alert, Button, Group, Modal, PasswordInput, Stack, Text, TextInput } from '@mantine/core';
import { useState } from 'react';
import { useAppStore } from '../../state/app-store-context';
import { errorText } from '../notify-error';
import {
  useDockerCredentialsStore,
  type DockerCredentialsRequest,
} from './docker-credentials-store';

const DEFAULT_AUTH_SOURCE = 'admin';

/** Mounted once in the shell. Opens when a container connect says the server needs credentials. */
export function DockerCredentialsDialog() {
  const request = useDockerCredentialsStore((state) => state.request);
  const close = useDockerCredentialsStore((state) => state.close);
  if (request === undefined) {
    return null;
  }
  return <DockerCredentialsForm key={request.containerId} request={request} onClose={close} />;
}

interface DockerCredentialsFormProps {
  readonly request: DockerCredentialsRequest;
  readonly onClose: () => void;
}

function DockerCredentialsForm({ request, onClose }: DockerCredentialsFormProps) {
  const connectWithCredentials = useAppStore((state) => state.connectContainerWithCredentials);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [authSource, setAuthSource] = useState(DEFAULT_AUTH_SOURCE);
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
      await connectWithCredentials({
        containerId: request.containerId,
        username,
        password,
        authSource: authSource.trim() === '' ? DEFAULT_AUTH_SOURCE : authSource.trim(),
      });
      onClose();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setSubmitting(false);
    }
  }

  const explanation =
    request.hint === 'envFound'
      ? 'The credentials in the container settings were rejected. Type a user and password that the server accepts.'
      : 'The server needs a user name and password, and the container does not set them.';

  return (
    <Modal opened onClose={onClose} title={`Connect to ${request.containerName}`} centered>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap="sm">
          <Text size="sm">{explanation}</Text>
          <TextInput
            label="Username"
            autoComplete="username"
            data-autofocus
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value)}
          />
          <PasswordInput
            label="Password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
          <TextInput
            label="Authentication database"
            description="The database that holds the user, usually admin"
            value={authSource}
            onChange={(event) => setAuthSource(event.currentTarget.value)}
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
