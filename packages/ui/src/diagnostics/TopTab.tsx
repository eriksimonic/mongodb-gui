import { Group, Stack, Table, Text, UnstyledButton } from '@mantine/core';
import { IconArrowDown, IconArrowUp } from '@tabler/icons-react';
import type { TopEntry } from '@mongo-gui/core';
import { useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { LoadState, RefreshButton } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { formatCount, formatMs } from './format';
import {
  DEFAULT_TOP_SORT,
  readCount,
  sortTop,
  topTotals,
  writeCount,
  type TopColumn,
  type TopSort,
} from './top-sort';

const NO_ENTRIES: readonly TopEntry[] = [];

export interface TopTabProps {
  readonly store: DiagnosticsStore;
}

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

  const entries = state.data ?? NO_ENTRIES;
  const rows = useMemo(() => sortTop(entries, sort), [entries, sort]);

  function sortBy(column: TopColumn) {
    setSort((current) =>
      current.column === column
        ? { column, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column, direction: column === 'ns' ? 'asc' : 'desc' },
    );
  }

  return (
    <Stack gap="xs" p="sm">
      <Group>
        <RefreshButton loading={state.loading} onRefresh={() => void load()} />
      </Group>
      <LoadState state={state}>
        {() => (
          <Table withTableBorder verticalSpacing={2} fz="xs" striped>
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
                  <Table.Td style={{ fontFamily: 'monospace' }}>{entry.ns}</Table.Td>
                  <Table.Td ta="right">{formatMs(entry.total.timeMs)}</Table.Td>
                  <Table.Td ta="right">{formatMs(entry.readLock.timeMs)}</Table.Td>
                  <Table.Td ta="right">{formatMs(entry.writeLock.timeMs)}</Table.Td>
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
      {state.data !== undefined && state.data.length === 0 ? (
        <Text size="sm" c="dimmed">
          The server reports no namespaces yet.
        </Text>
      ) : null}
    </Stack>
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
