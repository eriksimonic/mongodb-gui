import { Alert, Button, Checkbox, Group, Stack, Switch, Table, Text } from '@mantine/core';
import { IconTrash } from '@tabler/icons-react';
import type { SessionInfo, SessionUserInput } from '@mongo-gui/core';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { DestructiveDialog } from '../components/management/DestructiveDialog';
import { LoadState, RefreshButton } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { formatTimestamp } from './format';

export interface SessionsTabProps {
  readonly store: DiagnosticsStore;
}

type Confirmation =
  | { readonly kind: 'selected' }
  | { readonly kind: 'user'; readonly user: SessionUserInput }
  | undefined;

const FALLBACK_TEXT: Readonly<Record<string, string>> = {
  unauthorized:
    'This user lacks the privilege to list cluster sessions. The table shows this node only.',
  unsupported: 'This server does not list cluster sessions. The table shows this node only.',
};

/** The sessions of the server, with kill actions that ask for confirmation first. */
export function SessionsTab({ store }: SessionsTabProps) {
  const state = useStore(store, (current) => current.sessions);
  const allUsers = useStore(store, (current) => current.allUsers);
  const selected = useStore(store, (current) => current.selected);
  const load = useStore(store, (current) => current.loadSessions);
  const toggle = useStore(store, (current) => current.toggleSelected);
  const killSelected = useStore(store, (current) => current.killSelected);
  const killUserSessions = useStore(store, (current) => current.killUserSessions);
  const [confirmation, setConfirmation] = useState<Confirmation>(undefined);

  useEffect(() => {
    void load();
  }, [load]);

  const fallback = state.data?.fallbackReason;
  const rows = state.data?.sessions ?? [];

  return (
    <Stack gap="xs" p="sm">
      <Group gap="xs" align="center" wrap="wrap">
        <Switch
          label="All users in the cluster"
          aria-label="All users in the cluster"
          checked={allUsers}
          onChange={(event) => void load(event.currentTarget.checked)}
          size="xs"
        />
        <RefreshButton loading={state.loading} onRefresh={() => void load()} />
        <Button
          size="xs"
          color="red"
          variant="light"
          leftSection={<IconTrash size={14} />}
          disabled={selected.length === 0}
          onClick={() => setConfirmation({ kind: 'selected' })}
        >
          Kill selected ({selected.length})
        </Button>
      </Group>
      {fallback === undefined ? null : (
        <Alert variant="light" color="yellow">
          {FALLBACK_TEXT[fallback] ?? 'The table shows this node only.'}
        </Alert>
      )}
      <LoadState state={state}>
        {() =>
          rows.length === 0 ? (
            <Text size="sm" c="dimmed">
              No sessions.
            </Text>
          ) : (
            <Table withTableBorder verticalSpacing={2} fz="xs" striped>
              <Table.Thead>
                <Table.Tr>
                  <Table.Th w={36} />
                  <Table.Th>User</Table.Th>
                  <Table.Th>Database</Table.Th>
                  <Table.Th>Session id</Table.Th>
                  <Table.Th>Last use</Table.Th>
                  <Table.Th w={130}>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((session) => (
                  <SessionRow
                    key={session.id}
                    session={session}
                    checked={selected.includes(session.id)}
                    onToggle={() => toggle(session.id)}
                    onKillUser={(user) => setConfirmation({ kind: 'user', user })}
                  />
                ))}
              </Table.Tbody>
            </Table>
          )
        }
      </LoadState>
      {confirmation?.kind === 'selected' ? (
        <DestructiveDialog
          title={`Kill ${selected.length} ${selected.length === 1 ? 'session' : 'sessions'}`}
          description={
            <Stack gap={4}>
              <Text size="sm">
                The running operations of these sessions stop, and the sessions end:
              </Text>
              {selected.map((id) => (
                <Text key={id} size="xs" style={{ fontFamily: 'monospace' }}>
                  {id}
                </Text>
              ))}
            </Stack>
          }
          confirmLabel="Kill sessions"
          onConfirm={() => killSelected()}
          onClose={() => setConfirmation(undefined)}
        />
      ) : null}
      {confirmation?.kind === 'user' ? (
        <DestructiveDialog
          title={`Kill all sessions of ${confirmation.user.user}`}
          description={
            <Text size="sm">
              Every session and running operation of {confirmation.user.user} on{' '}
              {confirmation.user.db} stops. Other users keep running.
            </Text>
          }
          confirmLabel="Kill all sessions"
          typedConfirmation={confirmation.user.user}
          onConfirm={() => killUserSessions(confirmation.user)}
          onClose={() => setConfirmation(undefined)}
        />
      ) : null}
    </Stack>
  );
}

interface SessionRowProps {
  readonly session: SessionInfo;
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly onKillUser: (user: SessionUserInput) => void;
}

function SessionRow({ session, checked, onToggle, onKillUser }: SessionRowProps) {
  const user = session.name;
  const db = session.db;
  const canKillUser = user !== undefined && db !== undefined;
  return (
    <Table.Tr>
      <Table.Td>
        <Checkbox
          size="xs"
          checked={checked}
          onChange={onToggle}
          aria-label={`Select session ${session.id}`}
        />
      </Table.Td>
      <Table.Td>{user ?? session.user ?? session.userId ?? '(no user)'}</Table.Td>
      <Table.Td>{db ?? ''}</Table.Td>
      <Table.Td style={{ fontFamily: 'monospace' }}>{session.id}</Table.Td>
      <Table.Td>{formatTimestamp(session.lastUse)}</Table.Td>
      <Table.Td>
        <Button
          size="compact-xs"
          variant="subtle"
          color="red"
          disabled={!canKillUser}
          onClick={() => {
            if (user !== undefined && db !== undefined) {
              onKillUser({ user, db });
            }
          }}
        >
          Kill all of user
        </Button>
      </Table.Td>
    </Table.Tr>
  );
}
