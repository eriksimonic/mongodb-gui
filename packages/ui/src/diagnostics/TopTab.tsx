import {
  Group,
  Select,
  Switch,
  Table,
  Text,
  UnstyledButton,
  type MantineStyleProp,
} from '@mantine/core';
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react';
import type { TopEntry } from '@mongo-gui/core';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { LoadState, ScrollLayout, Toolbar } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { formatCount, formatMs } from './format';
import {
  DEFAULT_TOP_SORT,
  readCount,
  sortTop,
  topDelta,
  topTotals,
  writeCount,
  type TopColumn,
  type TopSort,
} from './top-sort';

const NO_ENTRIES: readonly TopEntry[] = [];

export interface TopTabProps {
  readonly store: DiagnosticsStore;
}

const INTERVALS = [
  { value: '0', label: 'Manual' },
  { value: '1000', label: 'Every 1s' },
  { value: '5000', label: 'Every 5s' },
  { value: '10000', label: 'Every 10s' },
];

const COLUMNS: readonly { key: TopColumn; label: string; time: boolean }[] = [
  { key: 'ns', label: 'Namespace', time: false },
  { key: 'total', label: 'Total time', time: true },
  { key: 'readLock', label: 'Read lock time', time: true },
  { key: 'writeLock', label: 'Write lock time', time: true },
  { key: 'reads', label: 'Reads', time: false },
  { key: 'writes', label: 'Writes', time: false },
  { key: 'commands', label: 'Commands', time: false },
];

/** The top command: time and operation counts per namespace, sortable by any column. */
export function TopTab({ store }: TopTabProps) {
  const state = useStore(store, (current) => current.top);
  const load = useStore(store, (current) => current.loadTop);
  const [sort, setSort] = useState<TopSort>(DEFAULT_TOP_SORT);

  useEffect(() => {
    void load();
  }, [load]);

  const [intervalMs, setIntervalMs] = useState<number>(0);
  const [delta, setDelta] = useState(false);
  const [pair, setPair] = useState<{
    readonly previous: readonly TopEntry[] | undefined;
    readonly current: readonly TopEntry[] | undefined;
  }>({ previous: undefined, current: undefined });

  // Keeps the snapshot before the newest one. Adjusting state while rendering avoids an extra pass.
  if (state.data !== undefined && state.data !== pair.current) {
    setPair({ previous: pair.current, current: state.data });
  }

  useEffect(() => {
    if (intervalMs === 0) {
      return undefined;
    }
    const timer = setInterval(() => void load(), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, load]);

  const waitingForDelta = delta && pair.previous === undefined;
  const entries =
    delta && pair.previous !== undefined && pair.current !== undefined
      ? topDelta(pair.previous, pair.current)
      : waitingForDelta
        ? NO_ENTRIES
        : (state.data ?? NO_ENTRIES);
  const rows = useMemo(() => sortTop(entries, sort), [entries, sort]);
  const totals = useMemo(() => topTotals(entries), [entries]);

  function sortBy(column: TopColumn) {
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: column === 'ns' ? 'asc' : 'desc' },
    );
  }

  return (
    <ScrollLayout
      toolbar={
        <Toolbar loading={state.loading} onRefresh={() => void load()}>
          <Select
            size="xs"
            w={130}
            aria-label="Refresh interval"
            allowDeselect={false}
            data={INTERVALS}
            value={String(intervalMs)}
            onChange={(value) => setIntervalMs(Number(value ?? 0))}
          />
          <Switch
            size="xs"
            label="Change since last refresh"
            checked={delta}
            onChange={(event) => setDelta(event.currentTarget.checked)}
          />
        </Toolbar>
      }
    >
      <LoadState state={state}>
        {() => (
          <Table withTableBorder stickyHeader verticalSpacing={2} fz="xs" striped>
            <Table.Thead>
              <Table.Tr>
                {COLUMNS.map((column) => (
                  <Table.Th key={column.key} ta={column.key === 'ns' ? 'left' : 'right'}>
                    <UnstyledButton
                      onClick={() => sortBy(column.key)}
                      aria-label={`Sort by ${column.label}`}
                    >
                      <Group
                        gap={2}
                        wrap="nowrap"
                        justify={column.key === 'ns' ? 'flex-start' : 'flex-end'}
                      >
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
                  </Table.Th>
                ))}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((entry) => (
                <Table.Tr key={entry.ns}>
                  <Table.Td style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>
                    <Namespace ns={entry.ns} />
                  </Table.Td>
                  <Table.Td ta="right" style={shareStyle(entry.total.timeMs, totals.total)}>
                    {formatMs(entry.total.timeMs)}
                  </Table.Td>
                  <Table.Td ta="right" style={shareStyle(entry.readLock.timeMs, totals.readLock)}>
                    {formatMs(entry.readLock.timeMs)}
                  </Table.Td>
                  <Table.Td
                    ta="right"
                    style={shareStyle(entry.writeLock.timeMs, totals.writeLock, 'orange')}
                  >
                    {formatMs(entry.writeLock.timeMs)}
                  </Table.Td>
                  <Table.Td ta="right">{formatCount(readCount(entry))}</Table.Td>
                  <Table.Td ta="right">{formatCount(writeCount(entry))}</Table.Td>
                  <Table.Td ta="right">{formatCount(entry.commands.count)}</Table.Td>
                </Table.Tr>
              ))}
              {entries.length === 0 ? null : <TotalsRow entries={entries} />}
            </Table.Tbody>
          </Table>
        )}
      </LoadState>
      {waitingForDelta ? (
        <Text size="sm" c="dimmed">
          Refresh once more to see what changed.
        </Text>
      ) : delta && entries.length === 0 ? (
        <Text size="sm" c="dimmed">
          No activity since the last refresh.
        </Text>
      ) : state.data !== undefined && state.data.length === 0 ? (
        <Text size="sm" c="dimmed">
          The server reports no namespaces yet.
        </Text>
      ) : null}
    </ScrollLayout>
  );
}

/** A bar behind the cell, as wide as the namespace's share of the column total. */
function shareStyle(value: number, total: number, color = 'blue'): MantineStyleProp {
  const share = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  if (share === 0) {
    return {};
  }
  return {
    background: `linear-gradient(to left, var(--mantine-color-${color}-light) ${share}%, transparent ${share}%)`,
    fontWeight: share >= 50 ? 600 : undefined,
  };
}

/** The database in a dimmer tone, so the collection name stands out. */
function Namespace({ ns }: { readonly ns: string }) {
  const dot = ns.indexOf('.');
  if (dot < 0) {
    return <>{ns}</>;
  }
  return (
    <>
      <Text span inherit c="dimmed">
        {ns.slice(0, dot + 1)}
      </Text>
      {ns.slice(dot + 1)}
    </>
  );
}

function TotalsRow({ entries }: { readonly entries: readonly TopEntry[] }) {
  const totals = topTotals(entries);
  return (
    <Table.Tr fw={600}>
      <Table.Td>Total</Table.Td>
      <Table.Td ta="right">{formatMs(totals.total)}</Table.Td>
      <Table.Td ta="right">{formatMs(totals.readLock)}</Table.Td>
      <Table.Td ta="right">{formatMs(totals.writeLock)}</Table.Td>
      <Table.Td ta="right">{formatCount(totals.reads)}</Table.Td>
      <Table.Td ta="right">{formatCount(totals.writes)}</Table.Td>
      <Table.Td ta="right">{formatCount(totals.commands)}</Table.Td>
    </Table.Tr>
  );
}
