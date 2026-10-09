import {
  Alert,
  Button,
  Code,
  Group,
  Loader,
  Modal,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Tooltip,
} from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { toAppError, type AppError, type RunningOperation } from '@mongo-gui/core';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import { formatDuration } from './format';
import { commandExcerpt, filterOperations, killBlockReason } from './operations-view';

const OPERATIONS_REFRESH_MS = 2000;

export interface OperationsPanelProps {
  readonly connectionId: string;
  /** Polling stops while the panel is hidden. Defaults to visible. */
  readonly visible?: boolean;
}

interface KillButtonProps {
  readonly operation: RunningOperation;
  readonly onKill: () => void;
}

/** Kill for one row. A row that cannot be killed shows its reason on hover and focus. */
function KillButton({ operation, onKill }: KillButtonProps) {
  const reason = killBlockReason(operation);
  const button = (
    <Button
      size="xs"
      color="red"
      variant="light"
      aria-label={`Kill operation ${String(operation.opid)}`}
      disabled={reason !== undefined}
      onClick={onKill}
    >
      Kill
    </Button>
  );
  if (reason === undefined) {
    return button;
  }
  return (
    <Tooltip label={reason} withArrow>
      <span tabIndex={0} style={{ display: 'inline-block' }}>
        {button}
      </span>
    </Tooltip>
  );
}

function yesNo(value: boolean | undefined): string {
  if (value === undefined) {
    return '';
  }
  return value ? 'Yes' : 'No';
}

/**
 * Running operations on one connection. Refreshes every two seconds while visible. Kill asks for
 * confirmation and then reloads the list. Idle connections have no opid, so they cannot be killed.
 */
export function OperationsPanel({ connectionId, visible = true }: OperationsPanelProps) {
  const { rpc } = useUiApi();
  const [includeIdle, setIncludeIdle] = useState(false);
  const [includeSystem, setIncludeSystem] = useState(false);
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<RunningOperation[] | undefined>(undefined);
  const [error, setError] = useState<AppError | undefined>(undefined);
  const [target, setTarget] = useState<RunningOperation | undefined>(undefined);
  const [killing, setKilling] = useState(false);
  const [killError, setKillError] = useState<AppError | undefined>(undefined);

  const refresh = useCallback(async () => {
    try {
      const next = await rpc.monitor.operations({ connectionId, includeIdle, includeSystem });
      setRows(next);
      setError(undefined);
    } catch (caught) {
      setError(toAppError(caught));
    }
  }, [rpc, connectionId, includeIdle, includeSystem]);

  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    const load = (): void => {
      void refresh();
    };
    // The first load runs on a zero timeout, so the effect itself never sets state.
    const first = setTimeout(load, 0);
    const timer = setInterval(load, OPERATIONS_REFRESH_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [visible, refresh]);

  const visibleRows = useMemo(() => filterOperations(rows ?? [], search), [rows, search]);

  function closeKillDialog(): void {
    if (!killing) {
      setTarget(undefined);
      setKillError(undefined);
    }
  }

  async function confirmKill(operation: RunningOperation): Promise<void> {
    setKilling(true);
    setKillError(undefined);
    try {
      await rpc.monitor.killOperation({ connectionId, opid: operation.opid });
      setTarget(undefined);
      await refresh();
    } catch (caught) {
      setKillError(toAppError(caught));
    } finally {
      setKilling(false);
    }
  }

  return (
    <Stack gap="sm" p="sm" data-testid="operations-panel">
      <Group justify="space-between" align="flex-end" wrap="wrap" gap="xs">
        <Group gap="sm" wrap="wrap" align="flex-end">
          <TextInput
            size="xs"
            w={240}
            placeholder="Search by namespace"
            aria-label="Search by namespace"
            leftSection={<IconSearch size={14} aria-hidden="true" />}
            value={search}
            onChange={(event) => {
              setSearch(event.currentTarget.value);
            }}
          />
          <Switch
            size="xs"
            label="Include idle connections"
            checked={includeIdle}
            onChange={(event) => {
              setIncludeIdle(event.currentTarget.checked);
            }}
          />
          <Switch
            size="xs"
            label="Include system threads"
            checked={includeSystem}
            onChange={(event) => {
              setIncludeSystem(event.currentTarget.checked);
            }}
          />
        </Group>
        <Text size="xs" c="dimmed">
          Refreshes every 2 s while visible
        </Text>
      </Group>

      {error === undefined ? null : (
        <Alert color="red" variant="light" title="Operations unavailable">
          {error.message}
        </Alert>
      )}

      {rows === undefined && error === undefined ? (
        <Loader size="sm" aria-label="Loading operations" />
      ) : null}

      {rows !== undefined && visibleRows.length === 0 ? (
        <Text size="sm" c="dimmed">
          No operations match.
        </Text>
      ) : null}

      {visibleRows.length === 0 ? null : (
        <Table striped highlightOnHover withTableBorder fz="xs">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Opid</Table.Th>
              <Table.Th>Type</Table.Th>
              <Table.Th>Description</Table.Th>
              <Table.Th>Namespace</Table.Th>
              <Table.Th>Running for</Table.Th>
              <Table.Th>Client</Table.Th>
              <Table.Th>App name</Table.Th>
              <Table.Th>Plan</Table.Th>
              <Table.Th>Waiting for lock</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {visibleRows.map((operation) => (
              <Table.Tr key={String(operation.opid)}>
                <Table.Td>{String(operation.opid)}</Table.Td>
                <Table.Td>{operation.op}</Table.Td>
                <Table.Td>{operation.desc ?? ''}</Table.Td>
                <Table.Td>{operation.ns}</Table.Td>
                <Table.Td>
                  {operation.secsRunning === undefined ? '' : formatDuration(operation.secsRunning)}
                </Table.Td>
                <Table.Td>{operation.client ?? ''}</Table.Td>
                <Table.Td>{operation.appName ?? ''}</Table.Td>
                <Table.Td>{operation.planSummary ?? ''}</Table.Td>
                <Table.Td>{yesNo(operation.waitingForLock)}</Table.Td>
                <Table.Td>
                  <KillButton
                    operation={operation}
                    onKill={() => {
                      setKillError(undefined);
                      setTarget(operation);
                    }}
                  />
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      )}

      <Modal
        opened={target !== undefined}
        onClose={closeKillDialog}
        title="Kill operation"
        centered
        size="md"
      >
        {target === undefined ? null : (
          <Stack gap="sm">
            <Text size="sm">
              {`Kill operation ${String(target.opid)} on ${target.ns === '' ? 'no namespace' : target.ns}?`}
            </Text>
            <Text size="xs" c="dimmed">
              The server stops the operation with an error. It cannot resume.
            </Text>
            <Code block>{commandExcerpt(target.command)}</Code>
            {killError === undefined ? null : (
              <Alert color="red" variant="light">
                {killError.message}
              </Alert>
            )}
            <Group justify="flex-end" gap="xs">
              <Button variant="default" onClick={closeKillDialog} disabled={killing}>
                Cancel
              </Button>
              <Button
                color="red"
                loading={killing}
                onClick={() => {
                  void confirmKill(target);
                }}
              >
                Kill
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </Stack>
  );
}
