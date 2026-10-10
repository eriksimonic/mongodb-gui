import { Alert, Button, Checkbox, Group, Modal, PasswordInput, Stack, Text } from '@mantine/core';
import type { ConnectionProfileSummary } from '@mongo-gui/core';
import { useEffect, useState, type FormEvent } from 'react';
import { useUiApi } from '../../api/ui-api';
import { invalidInputStyles } from '../../screens/field-state';
import { errorText } from '../notify-error';
import {
  CONNECTIONS_FILE_FILTER,
  CONNECTIONS_FILE_NAME,
  PASSPHRASE_HINT,
  selectionProblem,
  validateNewPassphrase,
} from './connections-file-model';

export interface ConnectionsExportModalProps {
  readonly opened: boolean;
  readonly onClose: () => void;
}

/**
 * Exports the chosen connections to a file encrypted under a passphrase typed for this export.
 * The save dialog runs after the form is valid, so a cancelled dialog writes nothing.
 */
export function ConnectionsExportModal({ opened, onClose }: ConnectionsExportModalProps) {
  return (
    <Modal opened={opened} onClose={onClose} title="Export connections" size="lg" centered>
      {opened ? <ExportForm onClose={onClose} /> : null}
    </Modal>
  );
}

function ExportForm({ onClose }: { readonly onClose: () => void }) {
  const { rpc } = useUiApi();
  const [connections, setConnections] = useState<ConnectionProfileSummary[] | undefined>(undefined);
  const [selected, setSelected] = useState<string[]>([]);
  const [passphrase, setPassphrase] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [savedPath, setSavedPath] = useState<string | undefined>(undefined);
  const [savedCount, setSavedCount] = useState(0);

  useEffect(() => {
    let active = true;
    rpc.connections
      .list()
      .then((loaded) => {
        if (active) {
          setConnections(loaded);
          setSelected(loaded.map((connection) => connection.id));
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setFailure(errorText(error));
        }
      });
    return () => {
      active = false;
    };
  }, [rpc]);

  const passphraseErrors = validateNewPassphrase(passphrase, confirmation);
  const selectionError = selectionProblem(selected);
  const shown = submitted ? passphraseErrors : { passphrase: undefined, confirmation: undefined };

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (
      busy ||
      passphraseErrors.passphrase !== undefined ||
      passphraseErrors.confirmation !== undefined ||
      selectionError !== undefined
    ) {
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      const picked = await rpc.app.showSaveDialog({
        title: 'Save connections as',
        defaultPath: CONNECTIONS_FILE_NAME,
        filters: [CONNECTIONS_FILE_FILTER],
      });
      if (picked.path === undefined) {
        return;
      }
      await rpc.connections.exportToFile({ profileIds: selected, passphrase, path: picked.path });
      setSavedCount(selected.length);
      setSavedPath(picked.path);
      setPassphrase('');
      setConfirmation('');
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  if (savedPath !== undefined) {
    return (
      <Stack gap="md">
        <Alert color="green" title="Connections exported" role="status">
          {`Saved ${savedCount} ${savedCount === 1 ? 'connection' : 'connections'} to ${savedPath}. The file needs its passphrase to open.`}
        </Alert>
        <Group justify="flex-end">
          <Button onClick={onClose}>Done</Button>
        </Group>
      </Stack>
    );
  }

  return (
    <form onSubmit={(event) => void handleSubmit(event)} noValidate>
      <Stack gap="sm">
        {connections === undefined ? (
          <Text size="sm" c="dimmed">
            Loading connections
          </Text>
        ) : (
          <Checkbox.Group
            label="Connections to export"
            value={selected}
            onChange={setSelected}
            error={submitted ? selectionError : undefined}
          >
            <Stack gap="xs" mt="xs">
              {connections.map((connection) => (
                <Checkbox key={connection.id} value={connection.id} label={connection.name} />
              ))}
            </Stack>
          </Checkbox.Group>
        )}
        <PasswordInput
          label="Passphrase"
          description={PASSPHRASE_HINT}
          autoComplete="new-password"
          value={passphrase}
          onChange={(event) => setPassphrase(event.currentTarget.value)}
          error={shown.passphrase}
          styles={invalidInputStyles(shown.passphrase)}
        />
        <PasswordInput
          label="Confirm passphrase"
          autoComplete="new-password"
          value={confirmation}
          onChange={(event) => setConfirmation(event.currentTarget.value)}
          error={shown.confirmation}
          styles={invalidInputStyles(shown.confirmation)}
        />
        {failure === undefined ? null : (
          <Alert color="red" title="Export failed" role="alert">
            {failure}
          </Alert>
        )}
        <Group justify="flex-end" gap="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={connections === undefined}>
            Export
          </Button>
        </Group>
      </Stack>
    </form>
  );
}
