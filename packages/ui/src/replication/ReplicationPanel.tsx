import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Code,
  Group,
  Menu,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { IconDotsVertical, IconPlus, IconRefresh } from '@tabler/icons-react';
import { useCallback, useEffect, useState } from 'react';
import { useStore } from 'zustand';
import type { ReplicaSetMember } from '@mongo-gui/core';
import { useUiApi } from '../api/ui-api';
import { StatCard } from '../kit/StatCard';
import { errorText } from '../kit/notify-error';
import { usePolling } from '../kit/use-polling';
import { FreezeDialog, InitiateDialog, StepDownDialog } from './ReplicationDialogs';
import { MemberDialog, type MemberDialogMode } from './MemberDialogs';
import {
  electableSecondaries,
  electionEvents,
  formatAgo,
  formatDuration,
  formatLag,
  isNoReplicationError,
  isUninitiatedError,
  memberCounts,
  memberMeaning,
  memberMeaningLabel,
  MEMBER_MEANING_COLOUR,
} from './replication-model';
import {
  AUTO_REFRESH_MS,
  createReplicationStore,
  type ReplicationStore,
} from './replication-store';

export interface ReplicationPanelProps {
  readonly connectionId: string;
  /** Called with the set name once the status is read, so the tab can carry it. */
  readonly onSetName?: (setName: string) => void;
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
export function ReplicationPanel({ connectionId, onSetName }: ReplicationPanelProps) {
  const api = useUiApi();
  const [store] = useState<ReplicationStore>(() => createReplicationStore(api, connectionId));
  const status = useStore(store, (state) => state.status);
  const config = useStore(store, (state) => state.config);
  const error = useStore(store, (state) => state.error);
  const loading = useStore(store, (state) => state.loading);
  const now = useStore(store, (state) => state.readAt);
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

  const setName = status?.setName;
  useEffect(() => {
    if (setName !== undefined) {
      onSetName?.(setName);
    }
  }, [setName, onSetName]);

  const pollRefresh = useCallback(() => void store.getState().refresh(), [store]);
  usePolling(pollRefresh, autoRefresh ? AUTO_REFRESH_MS : undefined);

  const uninitiated = status === undefined && isUninitiatedError(error);
  const standalone = status === undefined && isNoReplicationError(error);
  const self = status?.members.find((member) => member.self);
  const primary = status?.members.find((member) => member.state === 'PRIMARY');
  const selfIsPrimary = self?.state === 'PRIMARY';
  const counts = status === undefined ? { healthy: 0, majority: 0 } : memberCounts(status);

  return (
    <Stack gap="sm" p="md" h="100%" style={{ overflow: 'auto' }} data-testid="replication-panel">
      <Group justify="space-between" wrap="nowrap" gap="sm">
        <Group gap="sm" wrap="wrap">
          <Title order={4}>
            {status === undefined ? 'Replica set' : `Replica set ${status.setName}`}
          </Title>
          {primary === undefined ? null : (
            <Badge variant="light" color="blue" tt="none">
              Primary {primary.name}
            </Badge>
          )}
        </Group>
        <Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
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
                  disabled={!selfIsPrimary || statusStale}
                  onClick={() => setDialog({ kind: 'stepDown' })}
                >
                  Step down…
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

      {status === undefined ? null : (
        <SimpleGrid cols={4} spacing="sm">
          <StatCard label="Primary" value={primary?.name ?? 'none'} mono>
            {self !== undefined && self.name === primary?.name ? 'this connection' : null}
          </StatCard>
          <StatCard
            label="Oplog window"
            value={
              status.oplog === undefined
                ? 'Unknown'
                : formatDuration(Math.round(status.oplog.windowSeconds))
            }
          >
            {status.oplog?.sizeMb === undefined ? null : `of ${status.oplog.sizeMb} MB`}
          </StatCard>
          <StatCard label="Config" value={`v${config?.version ?? '–'}`}>
            {status.term === undefined ? null : `term ${status.term}`}
          </StatCard>
          <StatCard label="Members" value={String(status.members.length)}>
            {`${counts.healthy} healthy · majority ${counts.majority}`}
          </StatCard>
        </SimpleGrid>
      )}

      {error === undefined || uninitiated || standalone ? null : (
        <Alert color="red" variant="light" role="alert">
          {errorText(error)}
        </Alert>
      )}
      {uninitiated ? (
        <Alert color="blue" variant="light" title="No replica set yet">
          <Group justify="space-between" wrap="nowrap">
            <Text size="sm">
              This server runs with <Code>--replSet</Code> but has no configuration. Start a set
              with it.
            </Text>
            <Button size="xs" onClick={() => setDialog({ kind: 'initiate' })}>
              Initiate…
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
            <Table
              striped
              withTableBorder
              verticalSpacing="xs"
              fz="sm"
              style={{ whiteSpace: 'nowrap' }}
            >
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
                  <Table.Th>Indexes</Table.Th>
                  <Table.Th>Tags</Table.Th>
                  <Table.Th aria-label="Actions" />
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {status.members.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    now={now}
                    disabled={statusStale}
                    onAction={(next) => setDialog(next)}
                  />
                ))}
              </Table.Tbody>
            </Table>
          </Box>

          <Stack gap={4}>
            <Group gap="xs">
              <Text size="sm" fw={500}>
                Elections
              </Text>
              <Text size="xs" c="dimmed">
                last {electionEvents(status).length}
              </Text>
            </Group>
            {electionEvents(status).length === 0 ? (
              <Text size="sm" c="dimmed">
                The status reports no elections.
              </Text>
            ) : (
              electionEvents(status).map((event) => (
                <Group key={`${event.at}-${event.summary}`} gap="md" wrap="nowrap">
                  <Text size="sm" c="dimmed" w={110} title={formatInstant(event.at)}>
                    {formatAgo(event.at, now)}
                  </Text>
                  <Text size="sm" c="dimmed" ff="monospace" w={60}>
                    {event.term === undefined ? '' : `term ${event.term}`}
                  </Text>
                  <Text size="sm">{event.summary}</Text>
                </Group>
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
          electable={
            status === undefined
              ? []
              : electableSecondaries(status).map(
                  (member) => `${member.name} is ${formatLag(member.lagSeconds)} behind`,
                )
          }
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
  readonly electable: readonly string[];
  readonly selfName: string | undefined;
  readonly defaultHost: string | undefined;
  readonly onClose: () => void;
}

function DialogHost({
  dialog,
  store,
  setName,
  primaryName,
  electable,
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
          electable={electable}
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
  readonly now: number;
  /** True while the last read failed. The row's actions stay off until a read succeeds. */
  readonly disabled: boolean;
  readonly onAction: (dialog: OpenDialog) => void;
}

function MemberRow({ member, now, disabled, onAction }: MemberRowProps) {
  const meaning = memberMeaning(member);
  const tags = Object.entries(member.tags).map(([key, value]) => `${key}=${value}`);
  return (
    <Table.Tr>
      <Table.Td>
        <Text span ff="monospace" fz="sm">
          {member.name}
        </Text>
        {member.self ? (
          <Text span size="xs" c="dimmed">
            {' '}
            connected
          </Text>
        ) : null}
      </Table.Td>
      <Table.Td>
        <Badge
          color={MEMBER_MEANING_COLOUR[meaning]}
          variant="light"
          radius="sm"
          data-meaning={meaning}
          miw="max-content"
        >
          {memberMeaningLabel(meaning)}
        </Badge>
      </Table.Td>
      <Table.Td>
        <Group gap={6} wrap="nowrap">
          <Box
            w={7}
            h={7}
            style={{
              borderRadius: '50%',
              background: member.health === 1 ? 'var(--mg-link)' : 'var(--mg-danger)',
            }}
          />
          {member.health === 1 ? 'Up' : 'Down'}
        </Group>
      </Table.Td>
      <Table.Td ta="right">{formatLag(member.lagSeconds)}</Table.Td>
      <Table.Td>
        {member.optimeDate === undefined ? '–' : formatAgo(member.optimeDate, now)}
      </Table.Td>
      <Table.Td ta="right">{member.priority}</Table.Td>
      <Table.Td ta="right">{member.votes}</Table.Td>
      <Table.Td c="dimmed">{member.hidden ? 'Yes' : 'No'}</Table.Td>
      <Table.Td c="dimmed">{member.secondaryDelaySecs} s</Table.Td>
      <Table.Td>{member.buildIndexes ? 'Yes' : 'No'}</Table.Td>
      <Table.Td>
        {tags.length === 0 ? (
          '–'
        ) : (
          <Group gap={4} wrap="nowrap">
            {tags.map((tag) => (
              <Badge key={tag} variant="default" radius="sm" tt="none" ff="monospace">
                {tag}
              </Badge>
            ))}
          </Group>
        )}
      </Table.Td>
      <Table.Td>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon
              variant="subtle"
              color="gray"
              size="sm"
              aria-label={`Actions for ${member.name}`}
              disabled={disabled}
            >
              <IconDotsVertical size={14} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item onClick={() => onAction({ kind: 'member', mode: { kind: 'edit', member } })}>
              Edit member…
            </Menu.Item>
            <Menu.Item
              disabled={!member.self}
              rightSection={
                member.self ? undefined : (
                  <Text size="xs" c="dimmed">
                    connected member only
                  </Text>
                )
              }
              onClick={() => onAction({ kind: 'freeze' })}
            >
              Freeze…
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item
              color="red"
              onClick={() => onAction({ kind: 'member', mode: { kind: 'remove', member } })}
            >
              Remove from set…
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Table.Td>
    </Table.Tr>
  );
}

/** A timestamp in UTC, so the panel reads the same on every machine. */
function formatInstant(iso: string): string {
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}
