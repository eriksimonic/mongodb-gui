import {
  Alert,
  Badge,
  Box,
  Button,
  Group,
  Stack,
  Switch,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconPlus, IconRefresh } from '@tabler/icons-react';
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { ReplicaSetMember } from '@mongo-gui/core';
import { useUiApi } from '../api/ui-api';
import { errorText } from '../components/notify-error';
import { FreezeDialog, InitiateDialog, StepDownDialog } from './ReplicationDialogs';
import { MemberDialog, type MemberDialogMode } from './MemberDialogs';
import {
  electionEvents,
  formatLag,
  isNoReplicationError,
  isUninitiatedError,
  memberMeaning,
  memberMeaningLabel,
  MEMBER_MEANING_COLOUR,
  oplogWindowLabel,
} from './replication-model';
import {
  AUTO_REFRESH_MS,
  createReplicationStore,
  type ReplicationStore,
} from './replication-store';

export interface ReplicationPanelProps {
  readonly connectionId: string;
}

type OpenDialog =
  | { readonly kind: 'stepDown' }
  | { readonly kind: 'freeze' }
  | { readonly kind: 'initiate' }
  | { readonly kind: 'member'; readonly mode: MemberDialogMode };

/**
 * The replica set panel of one connection. It shows the members, the set header and the elections
 * the status reports, and runs the administration actions through dialogs.
 */
export function ReplicationPanel({ connectionId }: ReplicationPanelProps) {
  const api = useUiApi();
  const [store] = useState<ReplicationStore>(() => createReplicationStore(api, connectionId));
  const status = useStore(store, (state) => state.status);
  const config = useStore(store, (state) => state.config);
  const error = useStore(store, (state) => state.error);
  const loading = useStore(store, (state) => state.loading);
  const autoRefresh = useStore(store, (state) => state.autoRefresh);
  const setAutoRefresh = useStore(store, (state) => state.setAutoRefresh);
  const refresh = useStore(store, (state) => state.refresh);
  const statusStale = useStore(store, (state) => state.statusStale);
  const selfHost = useStore(store, (state) => state.selfHost);
  const [dialog, setDialog] = useState<OpenDialog | undefined>(undefined);

  useEffect(() => {
    void store.getState().refresh();
    void store.getState().loadSelfHost();
  }, [store]);

  useEffect(() => {
    if (!autoRefresh) {
      return undefined;
    }
    const timer = setInterval(() => void store.getState().refresh(), AUTO_REFRESH_MS);
    return () => clearInterval(timer);
  }, [autoRefresh, store]);

  const uninitiated = status === undefined && isUninitiatedError(error);
  const standalone = status === undefined && isNoReplicationError(error);
  const self = status?.members.find((member) => member.self);
  const primary = status?.members.find((member) => member.state === 'PRIMARY');
  const selfIsPrimary = self?.state === 'PRIMARY';

  return (
    <Stack gap="sm" p="sm" h="100%" style={{ overflow: 'auto' }} data-testid="replication-panel">
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="sm" wrap="wrap">
          <Title order={4}>
            {status === undefined ? 'Replica set' : `Replica set ${status.setName}`}
          </Title>
          {status === undefined ? null : (
            <>
              <Text size="sm">Primary: {primary?.name ?? 'none'}</Text>
              <Text size="sm">Oplog window: {oplogWindowLabel(status)}</Text>
              <Text size="sm">
                Config version {config?.version ?? '–'}, term {status.term ?? '–'}
              </Text>
            </>
          )}
        </Group>
        <Group gap="xs" wrap="nowrap">
          <Button
            variant="default"
            size="xs"
            leftSection={<IconRefresh size={14} />}
            loading={loading}
            onClick={() => void refresh()}
          >
            Refresh
          </Button>
          <Switch
            size="sm"
            label="Auto refresh 5 s"
            checked={autoRefresh}
            onChange={(event) => setAutoRefresh(event.currentTarget.checked)}
          />
          {status === undefined ? null : (
            <>
              <Tooltip
                label="Only the primary steps down. Connect to the primary to use this."
                disabled={selfIsPrimary}
              >
                <Button
                  variant="default"
                  size="xs"
                  color="orange"
                  disabled={!selfIsPrimary || statusStale}
                  onClick={() => setDialog({ kind: 'stepDown' })}
                >
                  Step down
                </Button>
              </Tooltip>
              <Button
                size="xs"
                leftSection={<IconPlus size={14} />}
                disabled={statusStale}
                onClick={() => setDialog({ kind: 'member', mode: { kind: 'add' } })}
              >
                Add member
              </Button>
            </>
          )}
        </Group>
      </Group>

      {error === undefined || uninitiated || standalone ? null : (
        <Alert color="red" variant="light" role="alert">
          {errorText(error)}
        </Alert>
      )}
      {uninitiated ? (
        <Alert color="blue" variant="light" title="No replica set yet">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">
              This server runs with --replSet but has no configuration. Start a set with it.
            </Text>
            <Button size="xs" onClick={() => setDialog({ kind: 'initiate' })}>
              Initiate
            </Button>
          </Group>
        </Alert>
      ) : null}
      {standalone ? (
        <Alert color="gray" variant="light" title="Not a replica set">
          This server was not started with --replSet, so it has no members to show.
        </Alert>
      ) : null}

      {status === undefined ? null : (
        <>
          <Box style={{ overflowX: 'auto' }}>
            <Table striped withTableBorder verticalSpacing="xs" fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Member</Table.Th>
                  <Table.Th>State</Table.Th>
                  <Table.Th>Health</Table.Th>
                  <Table.Th>Lag</Table.Th>
                  <Table.Th>Optime</Table.Th>
                  <Table.Th>Priority</Table.Th>
                  <Table.Th>Votes</Table.Th>
                  <Table.Th>Hidden</Table.Th>
                  <Table.Th>Delay</Table.Th>
                  <Table.Th>Arbiter</Table.Th>
                  <Table.Th>Build indexes</Table.Th>
                  <Table.Th>Tags</Table.Th>
                  <Table.Th>Actions</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {status.members.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    disabled={statusStale}
                    onAction={(next) => setDialog(next)}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </Box>

          <Stack gap={4}>
            <Text size="sm" fw={500}>
              Elections
            </Text>
            {electionEvents(status).length === 0 ? (
              <Text size="sm" c="dimmed">
                The status reports no elections.
              </Text>
            ) : (
              electionEvents(status).map((event) => (
                <Text key={`${event.at}-${event.summary}`} size="sm">
                  {formatInstant(event.at)}: {event.summary}
                </Text>
              ))
            )}
          </Stack>
        </>
      )}

      {dialog === undefined ? null : (
        <DialogHost
          dialog={dialog}
          store={store}
          setName={status?.setName ?? ''}
          primaryName={primary?.name}
          selfName={self?.name}
          defaultHost={selfHost}
          onClose={() => setDialog(undefined)}
        />
      )}
    </Stack>
  );
}

interface DialogHostProps {
  readonly dialog: OpenDialog;
  readonly store: ReplicationStore;
  readonly setName: string;
  readonly primaryName: string | undefined;
  readonly selfName: string | undefined;
  readonly defaultHost: string | undefined;
  readonly onClose: () => void;
}

function DialogHost({
  dialog,
  store,
  setName,
  primaryName,
  selfName,
  defaultHost,
  onClose,
}: DialogHostProps) {
  const state = store.getState();
  switch (dialog.kind) {
    case 'stepDown':
      return (
        <StepDownDialog
          primary={primaryName ?? 'The primary'}
          onStepDown={(seconds) => state.stepDown(seconds)}
          onClose={onClose}
        />
      );
    case 'freeze':
      return (
        <FreezeDialog
          member={selfName ?? 'The connected member'}
          onFreeze={(seconds) => state.freeze(seconds)}
          onClose={onClose}
        />
      );
    case 'initiate':
      return (
        <InitiateDialog
          defaultHost={defaultHost}
          onInitiate={(input) => state.initiate(input)}
          onClose={onClose}
        />
      );
    case 'member':
      return <MemberDialog mode={dialog.mode} setName={setName} store={store} onClose={onClose} />;
  }
}

interface MemberRowProps {
  readonly member: ReplicaSetMember;
  /** True while the last read failed. The row's actions stay off until a read succeeds. */
  readonly disabled: boolean;
  readonly onAction: (dialog: OpenDialog) => void;
}

function MemberRow({ member, disabled, onAction }: MemberRowProps) {
  const meaning = memberMeaning(member);
  const tags = Object.entries(member.tags)
    .map(([key, value]) => `${key}=${value}`)
    .join(', ');
  return (
    <Table.Tr>
      <Table.Td>
        {member.name}
        {member.self ? (
          <Text span size="xs" c="dimmed">
            {' '}
            (connected)
          </Text>
        ) : null}
      </Table.Td>
      <Table.Td>
        <Badge color={MEMBER_MEANING_COLOUR[meaning]} variant="light" data-meaning={meaning}>
          {memberMeaningLabel(meaning)}
        </Badge>
      </Table.Td>
      <Table.Td>{member.health === 1 ? 'Up' : 'Down'}</Table.Td>
      <Table.Td>{formatLag(member.lagSeconds)}</Table.Td>
      <Table.Td>
        {member.optimeDate === undefined ? '–' : formatInstant(member.optimeDate)}
      </Table.Td>
      <Table.Td>{member.priority}</Table.Td>
      <Table.Td>{member.votes}</Table.Td>
      <Table.Td>{member.hidden ? 'Yes' : 'No'}</Table.Td>
      <Table.Td>{member.secondaryDelaySecs} s</Table.Td>
      <Table.Td>{member.arbiterOnly ? 'Yes' : 'No'}</Table.Td>
      <Table.Td>{member.buildIndexes ? 'Yes' : 'No'}</Table.Td>
      <Table.Td>{tags === '' ? '–' : tags}</Table.Td>
      <Table.Td>
        <Group gap={4} wrap="nowrap">
          <Button
            size="compact-xs"
            variant="default"
            disabled={disabled}
            onClick={() => onAction({ kind: 'member', mode: { kind: 'edit', member } })}
          >
            Edit
          </Button>
          <Button
            size="compact-xs"
            variant="default"
            color="red"
            disabled={disabled}
            onClick={() => onAction({ kind: 'member', mode: { kind: 'remove', member } })}
          >
            Remove
          </Button>
          {member.self ? (
            <Button
              size="compact-xs"
              variant="default"
              disabled={disabled}
              onClick={() => onAction({ kind: 'freeze' })}
            >
              Freeze
            </Button>
          ) : null}
        </Group>
      </Table.Td>
    </Table.Tr>
  );
}

/** A timestamp in UTC, so the panel reads the same on every machine. */
function formatInstant(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}
