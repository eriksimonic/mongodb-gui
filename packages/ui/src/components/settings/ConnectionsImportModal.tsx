import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  PasswordInput,
  Radio,
  Stack,
  Table,
  Text,
} from '@mantine/core';
import type {
  ConnectionsImportMode,
  ConnectionsImportPreview,
  ConnectionsImportResult,
} from '@mongo-gui/core';
import { useState, type FormEvent } from 'react';
import { useUiApi } from '../../api/ui-api';
import { invalidInputStyles } from '../../screens/field-state';
import { useAppStore } from '../../state/app-store-context';
import { errorText } from '../notify-error';
import {
  IMPORT_MODE_OPTIONS,
  PASSPHRASE_HINT,
  validateExistingPassphrase,
} from './connections-file-model';

export interface ConnectionsImportModalProps {
  /** The file the open dialog returned. The modal is closed while there is none. */
  readonly path: string | undefined;
  readonly onClose: () => void;
}

/**
 * Reads a connections file the user picked, previews its connections, and imports them. The
 * connection tree reloads after an import.
 */
export function ConnectionsImportModal({ path, onClose }: ConnectionsImportModalProps) {
  return (
    <Modal
      opened={path !== undefined}
      onClose={onClose}
      title="Import connections"
      size="lg"
      centered
    >
      {path === undefined ? null : <ImportForm path={path} onClose={onClose} />}
    </Modal>
  );
}

function ImportForm({ path, onClose }: { readonly path: string; readonly onClose: () => void }) {
  const { rpc } = useUiApi();
  const loadConnections = useAppStore((state) => state.loadConnections);
  const [passphrase, setPassphrase] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [preview, setPreview] = useState<ConnectionsImportPreview | undefined>(undefined);
  const [mode, setMode] = useState<ConnectionsImportMode>('rename');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<ConnectionsImportResult | undefined>(undefined);

  const passphraseError = validateExistingPassphrase(passphrase);
  const shownError = submitted ? passphraseError : undefined;

  async function readFile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    if (busy || passphraseError !== undefined) {
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      setPreview(await rpc.connections.previewImport({ path, passphrase }));
    } catch (error) {
      setPreview(undefined);
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function runImport() {
    setBusy(true);
    setFailure(undefined);
    try {
      const imported = await rpc.connections.importFromFile({ path, passphrase, mode });
      setResult(imported);
      await loadConnections();
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  if (result !== undefined) {
    return (
      <Stack gap="md">
        <Alert color="green" title="Connections imported" role="status">
          {`Imported ${result.imported}, renamed ${result.renamed}, replaced ${result.replaced}, skipped ${result.skipped}.`}
        </Alert>
        <Group justify="flex-end">
          <Button onClick={onClose}>Done</Button>
        </Group>
      </Stack>
    );
  }

  return (
    <Stack gap="md">
      <Text size="sm" c="dimmed" style={{ wordBreak: 'break-all' }}>
        {path}
      </Text>
      <form onSubmit={(event) => void readFile(event)} noValidate>
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <PasswordInput
            label="Passphrase"
            description={PASSPHRASE_HINT}
            autoComplete="off"
            value={passphrase}
            onChange={(event) => setPassphrase(event.currentTarget.value)}
            error={shownError}
            styles={invalidInputStyles(shownError)}
            style={{ flex: 1 }}
            autoFocus
          />
          <Button type="submit" variant="default" loading={busy && preview === undefined}>
            Read file
          </Button>
        </Group>
      </form>
      {failure === undefined ? null : (
        <Alert color="red" title="Import failed" role="alert">
          {failure}
        </Alert>
      )}
      {preview === undefined ? null : (
        <Stack gap="sm">
          <Table striped withTableBorder aria-label="Connections in the file">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Host</Table.Th>
                <Table.Th>Auth</Table.Th>
                <Table.Th>Name in use</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {preview.profiles.map((profile, index) => (
                // The file can hold the same name twice, so the index is part of the key.
                <Table.Tr key={`${profile.name}-${index}`}>
                  <Table.Td>{profile.name}</Table.Td>
                  <Table.Td>{profile.host}</Table.Td>
                  <Table.Td>{AUTH_LABELS[profile.authKind]}</Table.Td>
                  <Table.Td>
                    {profile.collides ? <Badge color="yellow">Exists</Badge> : null}
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
          <Radio.Group
            label="When a name already exists"
            value={mode}
            onChange={(value) => {
              const option = IMPORT_MODE_OPTIONS.find((item) => item.value === value);
              if (option !== undefined) {
                setMode(option.value);
              }
            }}
          >
            <Stack gap="xs" mt="xs">
              {IMPORT_MODE_OPTIONS.map((option) => (
                <Radio key={option.value} value={option.value} label={option.label} />
              ))}
            </Stack>
          </Radio.Group>
          <Group justify="flex-end" gap="xs">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={busy && preview !== undefined} onClick={() => void runImport()}>
              Import
            </Button>
          </Group>
        </Stack>
      )}
    </Stack>
  );
}

const AUTH_LABELS: Record<ConnectionsImportPreview['profiles'][number]['authKind'], string> = {
  none: 'None',
  password: 'Username and password',
  x509: 'X.509 certificate',
  other: 'Other',
};
