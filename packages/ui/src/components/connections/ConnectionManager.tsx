import {
  Button,
  Checkbox,
  ColorSwatch,
  Group,
  Modal,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  UnstyledButton,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import type { ConnectionProfile, ConnectionProfileInput } from '@mongo-gui/core';
import {
  IconArrowDown,
  IconArrowUp,
  IconCopy,
  IconDatabaseExport,
  IconDatabaseImport,
  IconLink,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconTrash,
} from '@tabler/icons-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useUiApi } from '../../api/ui-api';
import { useAppStore } from '../../state/app-store-context';
import { runReported } from '../notify-error';
import { ConnectionsExportModal } from '../settings/ConnectionsExportModal';
import { ConnectionsImportModal } from '../settings/ConnectionsImportModal';
import { CONNECTIONS_FILE_FILTER } from '../settings/connections-file-model';
import {
  DEFAULT_CONNECTION_SORT,
  EMPTY_FILTERS,
  formatAge,
  securityText,
  serverText,
  visibleConnections,
  type ConnectionColumn,
  type ConnectionFilters,
  type ConnectionSort,
} from './connection-table-model';

const COLUMNS: readonly { key: ConnectionColumn; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'server', label: 'Server' },
  { key: 'security', label: 'Security' },
  { key: 'color', label: 'Color' },
  { key: 'lastAccessed', label: 'Last accessed' },
];

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
  const [filters, setFilters] = useState<ConnectionFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<ConnectionSort>(DEFAULT_CONNECTION_SORT);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [exporting, setExporting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [importPath, setImportPath] = useState<string | undefined>(undefined);

  const all = connections.state === 'ready' ? connections.data : [];
  const rows = useMemo(() => visibleConnections(all, filters, sort), [all, filters, sort]);
  // A removed connection leaves the selection, so a toolbar action never targets a missing row.
  const chosen = all.filter((connection) => selected.includes(connection.id));
  const single = chosen.length === 1 ? chosen[0] : undefined;
  const allShown = rows.length > 0 && rows.every((row) => selected.includes(row.id));

  function sortBy(column: ConnectionColumn) {
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: column === 'lastAccessed' ? 'desc' : 'asc' },
    );
  }

  function toggle(id: string) {
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );
  }

  function toggleAll() {
    setSelected(allShown ? [] : rows.map((row) => row.id));
  }

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
          setSelected([]);
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
              color: 'green',
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
    notifications.show({ title: 'Copied', message: 'The redacted URI is on the clipboard.' });
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
      title="Connections"
      size="min(1000px, 94vw)"
      centered
      closeButtonProps={{ 'aria-label': 'Close' }}
    >
      <Stack gap="sm">
        <Group gap={2} wrap="wrap">
          <ToolButton icon={<IconPlus size={16} />} onClick={() => setDialog({ kind: 'create' })}>
            New connection
          </ToolButton>
          <ToolButton
            icon={<IconPencil size={16} />}
            disabled={single === undefined}
            onClick={() => single && setDialog({ kind: 'edit', connectionId: single.id })}
          >
            Edit
          </ToolButton>
          <ToolButton
            icon={<IconTrash size={16} />}
            disabled={chosen.length === 0}
            onClick={confirmDelete}
          >
            Delete
          </ToolButton>
          <ToolButton
            icon={<IconCopy size={16} />}
            disabled={single === undefined}
            onClick={() => void runReported(clone)}
          >
            Clone
          </ToolButton>
          <ToolButton
            icon={<IconPlayerPlay size={16} />}
            disabled={single === undefined}
            loading={testing}
            onClick={() => void runReported(test)}
          >
            Test
          </ToolButton>
          <ToolButton
            icon={<IconLink size={16} />}
            disabled={single === undefined}
            onClick={() => void runReported(copyUri)}
          >
            To URI
          </ToolButton>
          <ToolButton icon={<IconDatabaseExport size={16} />} onClick={() => setExporting(true)}>
            Export
          </ToolButton>
          <ToolButton
            icon={<IconDatabaseImport size={16} />}
            onClick={() => void runReported(chooseImportFile)}
          >
            Import
          </ToolButton>
        </Group>
        {connections.state !== 'ready' ? (
          <Text size="sm" c="dimmed">
            {connections.state === 'error' ? connections.error.message : 'Loading connections'}
          </Text>
        ) : (
          <ScrollArea.Autosize mah="60vh" type="auto">
            <Table stickyHeader highlightOnHover verticalSpacing={6} fz="sm" withTableBorder>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={36}>
                    <Checkbox
                      size="xs"
                      aria-label="Select all connections"
                      checked={allShown}
                      indeterminate={!allShown && selected.length > 0}
                      onChange={toggleAll}
                    />
                  </Table.Th>
                  {COLUMNS.map((column) => (
                    <Table.Th key={column.key}>
                      <Stack gap={4}>
                        <UnstyledButton
                          onClick={() => sortBy(column.key)}
                          aria-label={`Sort by ${column.label}`}
                        >
                          <Group gap={2} wrap="nowrap">
                            {column.label}
                            {sort.column === column.key ? (
                              sort.direction === 'asc' ? (
                                <IconArrowUp size={12} />
                              ) : (
                                <IconArrowDown size={12} />
                              )
                            ) : null}
                          </Group>
                        </UnstyledButton>
                        <TextInput
                          size="xs"
                          aria-label={`Filter ${column.label}`}
                          value={filters[column.key]}
                          onChange={(event) =>
                            setFilters({ ...filters, [column.key]: event.currentTarget.value })
                          }
                        />
                      </Stack>
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((connection) => {
                  const picked = selected.includes(connection.id);
                  return (
                    <Table.Tr
                      key={connection.id}
                      style={{
                        cursor: 'pointer',
                        ...(picked ? { background: 'var(--mantine-primary-color-light)' } : {}),
                      }}
                      onClick={(event) =>
                        // A plain click picks this row alone. Ctrl or Cmd adds or removes it.
                        event.ctrlKey || event.metaKey
                          ? toggle(connection.id)
                          : setSelected([connection.id])
                      }
                      onDoubleClick={() => {
                        setManagerOpen(false);
                        void expandConnection(connection.id);
                      }}
                    >
                      <Table.Td onClick={(event) => event.stopPropagation()}>
                        <Checkbox
                          size="xs"
                          aria-label={`Select ${connection.name}`}
                          checked={picked}
                          onChange={() => toggle(connection.id)}
                        />
                      </Table.Td>
                      <Table.Td fw={600} style={{ color: connection.color }}>
                        {connection.name}
                      </Table.Td>
                      <Table.Td style={{ fontFamily: 'monospace' }}>
                        {serverText(connection)}
                      </Table.Td>
                      <Table.Td>{securityText(connection)}</Table.Td>
                      <Table.Td>
                        {connection.color === undefined ? null : (
                          <Group gap={6} wrap="nowrap">
                            <ColorSwatch color={connection.color} size={12} />
                            <Text size="xs">{connection.color}</Text>
                          </Group>
                        )}
                      </Table.Td>
                      <Table.Td c="dimmed">{formatAge(connection.lastAccessedAt)}</Table.Td>
                    </Table.Tr>
                  );
                })}
              </Table.Tbody>
            </Table>
          </ScrollArea.Autosize>
        )}
        {connections.state === 'ready' && rows.length === 0 ? (
          <Text size="sm" c="dimmed">
            {all.length === 0 ? 'No saved connections yet.' : 'No connection matches the filters.'}
          </Text>
        ) : null}
        <Group justify="flex-end" gap="xs">
          <Button
            size="xs"
            disabled={chosen.length === 0}
            onClick={() => void runReported(connectChosen)}
          >
            Connect
          </Button>
          <Button size="xs" variant="default" onClick={() => setManagerOpen(false)}>
            Cancel
          </Button>
        </Group>
      </Stack>
      <ConnectionsExportModal opened={exporting} onClose={() => setExporting(false)} />
      <ConnectionsImportModal path={importPath} onClose={() => setImportPath(undefined)} />
    </Modal>
  );
}

function ToolButton({
  icon,
  disabled = false,
  loading = false,
  onClick,
  children,
}: {
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly loading?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Button
      size="xs"
      variant="subtle"
      color="gray"
      leftSection={icon}
      disabled={disabled}
      loading={loading}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
