import {
  Box,
  Button,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import type {
  ConnectionProfile,
  ConnectionProfileInput,
  ConnectionProfileSummary,
} from '@mongo-gui/core';
import { IconDownload, IconPlus, IconSearch, IconUpload } from '@tabler/icons-react';
import { useMemo, useState } from 'react';
import { parseMongoUri } from './uri-form';
import { useUiApi } from '../api/ui-api';
import { useAppStore } from '../state/app-store-context';
import { runReported } from '../kit/notify-error';
import {
  CONNECTIONS_FILE_FILTER,
  ConnectionsExportModal,
  ConnectionsImportModal,
} from '../settings';
import {
  DEFAULT_CONNECTION_SORT,
  EMPTY_FILTERS,
  formatAge,
  serverText,
  visibleConnections,
} from './connection-table-model';

/** The saved fields of a profile, as the input for a new one. */
function inputOf(profile: ConnectionProfile): ConnectionProfileInput {
  const { id, createdAt, updatedAt, lastAccessedAt, source, dockerContainerId, ...rest } = profile;
  void id;
  void createdAt;
  void updatedAt;
  void lastAccessedAt;
  void source;
  void dockerContainerId;
  return rest;
}

/**
 * The saved connections as a table: sort and filter by column, pick rows with the checkboxes, then
 * edit, clone, test, copy the URI, delete, export, import or connect.
 */
export function ConnectionManager() {
  const { rpc } = useUiApi();
  const open = useAppStore((state) => state.managerOpen);
  const setManagerOpen = useAppStore((state) => state.setManagerOpen);
  const connections = useAppStore((state) => state.connections);
  const setDialog = useAppStore((state) => state.setDialog);
  const removeConnection = useAppStore((state) => state.removeConnection);
  const loadConnections = useAppStore((state) => state.loadConnections);
  const expandConnection = useAppStore((state) => state.expandConnection);
  const statuses = useAppStore((state) => state.statuses);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [exporting, setExporting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [importPath, setImportPath] = useState<string | undefined>(undefined);

  const all = useMemo(() => (connections.state === 'ready' ? connections.data : []), [connections]);
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleConnections(all, EMPTY_FILTERS, DEFAULT_CONNECTION_SORT).filter(
      (connection) =>
        needle === '' ||
        connection.name.toLowerCase().includes(needle) ||
        serverText(connection).toLowerCase().includes(needle),
    );
  }, [all, query]);
  // The first row is shown until one is picked, and a removed connection never stays picked.
  const single = all.find((connection) => connection.id === selectedId) ?? rows[0];
  const chosen = single === undefined ? [] : [single];

  function confirmDelete() {
    const names = chosen.map((connection) => connection.name);
    modals.openConfirmModal({
      title: chosen.length === 1 ? 'Remove connection' : `Remove ${chosen.length} connections`,
      centered: true,
      children: (
        <Text size="sm">
          Remove {names.join(', ')}? Saved URIs are deleted. This cannot be undone.
        </Text>
      ),
      labels: { confirm: 'Remove', cancel: 'Cancel' },
      confirmProps: { color: 'red' },
      onConfirm: () => {
        void runReported(async () => {
          for (const connection of chosen) {
            await removeConnection(connection.id);
          }
          setSelectedId(undefined);
        });
      },
    });
  }

  async function clone() {
    if (single === undefined) {
      return;
    }
    const profile = await rpc.connections.get({ id: single.id });
    await rpc.connections.create({ ...inputOf(profile), name: `${profile.name} copy` });
    await loadConnections();
  }

  async function test() {
    if (single === undefined) {
      return;
    }
    const id = `test-${single.id}`;
    setTesting(true);
    notifications.show({
      id,
      loading: true,
      title: `Testing ${single.name}`,
      message: 'Connecting to the server.',
      autoClose: false,
      withCloseButton: false,
    });
    try {
      const profile = await rpc.connections.get({ id: single.id });
      const result = await rpc.connections.test(inputOf(profile));
      notifications.update(
        result.ok
          ? {
              id,
              loading: false,
              color: 'blue',
              title: 'Connection works',
              message: `${profile.name} answered. MongoDB ${result.serverVersion}.`,
              autoClose: 5000,
              withCloseButton: true,
            }
          : {
              id,
              loading: false,
              color: 'red',
              title: `${profile.name} failed`,
              message: result.error.message,
              autoClose: 8000,
              withCloseButton: true,
            },
      );
    } catch (error) {
      notifications.hide(id);
      throw error;
    } finally {
      setTesting(false);
    }
  }

  async function copyUri() {
    if (single === undefined) {
      return;
    }
    await navigator.clipboard.writeText(single.uriRedacted);
    notifications.show({
      title: 'Copied',
      message: 'The URI without its password is on the clipboard.',
    });
  }

  async function chooseImportFile() {
    const picked = await rpc.app.showOpenDialog({
      title: 'Choose a connections file',
      filters: [CONNECTIONS_FILE_FILTER],
    });
    if (picked.path !== undefined) {
      setImportPath(picked.path);
    }
  }

  async function connectChosen() {
    setManagerOpen(false);
    for (const connection of chosen) {
      await expandConnection(connection.id);
    }
  }

  return (
    <Modal
      opened={open}
      onClose={() => setManagerOpen(false)}
      title={
        <Group justify="space-between" wrap="nowrap" w="100%">
          <Text fw={600} size="lg">
            Connections
          </Text>
          <Group gap="xs" wrap="nowrap">
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              leftSection={<IconUpload size={14} />}
              onClick={() => void runReported(chooseImportFile)}
            >
              Import
            </Button>
            <Button
              size="xs"
              variant="subtle"
              color="gray"
              leftSection={<IconDownload size={14} />}
              onClick={() => setExporting(true)}
            >
              Export
            </Button>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconPlus size={14} />}
              onClick={() => setDialog({ kind: 'create' })}
            >
              New connection
            </Button>
          </Group>
        </Group>
      }
      size="min(1080px, 94vw)"
      centered
      padding={0}
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      <Group
        align="stretch"
        gap={0}
        wrap="nowrap"
        h="min(620px, 80vh)"
        style={{ borderTop: '1px solid var(--mg-border)' }}
      >
        <Stack
          gap="xs"
          w={380}
          p="sm"
          style={{ borderRight: '1px solid var(--mg-border)', flexShrink: 0, minHeight: 0 }}
        >
          <TextInput
            size="xs"
            aria-label="Search connections"
            placeholder="Search by name or host"
            leftSection={<IconSearch size={14} />}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <Text size="xs" c="dimmed">
            {all.length} saved, stored encrypted
          </Text>
          {connections.state !== 'ready' ? (
            <Text size="sm" c="dimmed">
              {connections.state === 'error' ? connections.error.message : 'Loading connections'}
            </Text>
          ) : (
            <ScrollArea style={{ flex: 1 }} type="auto">
              <Stack gap={0} role="listbox" aria-label="Saved connections">
                {rows.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    picked={connection.id === single?.id}
                    status={statuses[connection.id]?.state}
                    onPick={() => setSelectedId(connection.id)}
                    onOpen={() => {
                      setManagerOpen(false);
                      void expandConnection(connection.id);
                    }}
                  />
                ))}
              </Stack>
              {rows.length === 0 ? (
                <Text size="sm" c="dimmed" p="xs">
                  {all.length === 0
                    ? 'No saved connections yet.'
                    : 'No connection matches the search.'}
                </Text>
              ) : null}
            </ScrollArea>
          )}
        </Stack>
        <Stack gap="md" p="md" style={{ flex: 1, minWidth: 0 }}>
          {single === undefined ? (
            <Text size="sm" c="dimmed">
              Pick a connection to see its details.
            </Text>
          ) : (
            <>
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
                  <Box
                    w={12}
                    h={12}
                    style={{
                      borderRadius: '50%',
                      background: single.color ?? 'var(--mg-border-strong)',
                      flexShrink: 0,
                    }}
                  />
                  <Text fw={600} size="lg" truncate="end">
                    {single.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {statusLabel(statuses[single.id]?.state)}
                  </Text>
                </Group>
                <Group gap="xs" wrap="nowrap">
                  <Button
                    size="xs"
                    variant="default"
                    loading={testing}
                    onClick={() => void runReported(test)}
                  >
                    Test
                  </Button>
                  <Button size="xs" onClick={() => void runReported(connectChosen)}>
                    Connect
                  </Button>
                </Group>
              </Group>
              <ScrollArea style={{ flex: 1 }} type="auto">
                <DetailRows connection={single} />
              </ScrollArea>
              <Group justify="space-between" wrap="nowrap">
                <Group gap="xs" wrap="nowrap">
                  <Button
                    size="xs"
                    variant="default"
                    onClick={() => setDialog({ kind: 'edit', connectionId: single.id })}
                  >
                    Edit
                  </Button>
                  <Button size="xs" variant="default" onClick={() => void runReported(clone)}>
                    Duplicate
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => void runReported(copyUri)}
                  >
                    Copy URI without password
                  </Button>
                </Group>
                <Button size="xs" variant="outline" color="red" onClick={confirmDelete}>
                  Delete
                </Button>
              </Group>
              <Text size="xs" c="dimmed">
                Deleting a connection removes its saved URI and stored password. This cannot be
                undone.
              </Text>
            </>
          )}
        </Stack>
      </Group>
      <ConnectionsExportModal opened={exporting} onClose={() => setExporting(false)} />
      <ConnectionsImportModal path={importPath} onClose={() => setImportPath(undefined)} />
    </Modal>
  );
}

function statusLabel(state: string | undefined): string {
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'connecting':
      return 'Connecting';
    case 'error':
      return 'Error';
    default:
      return 'Disconnected';
  }
}

function ConnectionRow({
  connection,
  picked,
  status,
  onPick,
  onOpen,
}: {
  readonly connection: ConnectionProfileSummary;
  readonly picked: boolean;
  readonly status: string | undefined;
  readonly onPick: () => void;
  readonly onOpen: () => void;
}) {
  return (
    <UnstyledButton
      role="option"
      aria-selected={picked}
      onClick={onPick}
      onDoubleClick={onOpen}
      px="sm"
      py={8}
      style={{
        display: 'block',
        width: '100%',
        borderLeft: `3px solid ${connection.color ?? 'var(--mg-border-strong)'}`,
        borderBottom: '1px solid var(--mg-border)',
        background: picked ? 'var(--mg-surface-2)' : 'transparent',
      }}
    >
      <Group justify="space-between" wrap="nowrap" align="flex-start">
        <Stack gap={2} style={{ minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Text size="sm" fw={500} truncate="end">
              {connection.name}
            </Text>
          </Group>
          <Text size="xs" c="dimmed" ff="monospace" truncate="end">
            {serverText(connection)}
          </Text>
        </Stack>
        <Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
          {status === 'connected' ? 'connected' : formatAge(connection.lastAccessedAt)}
        </Text>
      </Group>
    </UnstyledButton>
  );
}

function DetailRows({ connection }: { readonly connection: ConnectionProfileSummary }) {
  const parsed = parseMongoUri(connection.uriRedacted);
  const form = parsed.ok ? parsed.form : undefined;
  const rows: [string, string][] = [['Connection string', connection.uriRedacted]];
  if (form !== undefined) {
    rows.push(['Scheme', form.scheme]);
    rows.push([
      'Hosts',
      form.hosts.length === 1
        ? (form.hosts[0] ?? '')
        : `${form.hosts.length}${form.replicaSet === '' ? '' : `, replica set ${form.replicaSet}`}`,
    ]);
    if (form.username !== '') {
      rows.push([
        'User',
        form.authSource === ''
          ? form.username
          : `${form.username}, auth database ${form.authSource}`,
      ]);
    }
    if (form.database !== '') {
      rows.push(['Default database', form.database]);
    }
  }
  const readPreference = connection.readPreference ?? form?.readPreference;
  if (readPreference !== undefined) {
    rows.push(['Read preference', readPreference]);
  }
  const tls = connection.tls;
  if (tls?.enabled === true || form?.tls.enabled === true || form?.scheme === 'mongodb+srv') {
    rows.push([
      'TLS',
      tls?.caFile === undefined || tls.caFile === '' ? 'on' : `on, CA file ${tls.caFile}`,
    ]);
  }
  const timeout = connection.connectTimeoutMs ?? form?.connectTimeoutMs;
  if (timeout !== undefined) {
    rows.push(['Connect timeout', `${timeout} ms`]);
  }
  rows.push([
    'Last connected',
    connection.lastAccessedAt === undefined ? 'Never' : formatAge(connection.lastAccessedAt),
  ]);
  return (
    <Stack gap={0}>
      {rows.map(([label, value]) => (
        <Group
          key={label}
          wrap="nowrap"
          align="flex-start"
          py={8}
          style={{ borderBottom: '1px solid var(--mg-border)' }}
        >
          <Text size="sm" c="dimmed" w={150} style={{ flexShrink: 0 }}>
            {label}
          </Text>
          <Text size="sm" ff="monospace" style={{ wordBreak: 'break-all', minWidth: 0 }}>
            {value}
          </Text>
        </Group>
      ))}
    </Stack>
  );
}
