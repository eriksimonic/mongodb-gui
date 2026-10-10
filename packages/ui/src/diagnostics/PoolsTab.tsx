import { Stack, Table } from '@mantine/core';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { KeyValueTable, LoadState, RefreshButton, Section } from './common';
import type { DiagnosticsStore } from './diagnostics-store';
import { formatCount } from './format';

export interface PoolsTabProps {
  readonly store: DiagnosticsStore;
}

/** Connection pool totals and the pool of each host. */
export function PoolsTab({ store }: PoolsTabProps) {
  const state = useStore(store, (current) => current.pools);
  const load = useStore(store, (current) => current.loadPools);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Stack gap="md" p="sm">
      <RefreshButton loading={state.loading} onRefresh={() => void load()} />
      <LoadState state={state}>
        {(pools) => (
          <>
            <Section title="Totals">
              <KeyValueTable
                rows={[
                  { label: 'In use', value: formatCount(pools.totalInUse) },
                  { label: 'Available', value: formatCount(pools.totalAvailable) },
                  { label: 'Created', value: formatCount(pools.totalCreated) },
                ]}
              />
            </Section>
            <Section title="Hosts">
              <Table withTableBorder verticalSpacing={2} fz="xs" striped>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>Host</Table.Th>
                    <Table.Th ta="right">In use</Table.Th>
                    <Table.Th ta="right">Available</Table.Th>
                    <Table.Th ta="right">Created</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {Object.entries(pools.hosts).map(([host, stats]) => (
                    <Table.Tr key={host}>
                      <Table.Td style={{ fontFamily: 'monospace' }}>{host}</Table.Td>
                      <Table.Td ta="right">{formatCount(stats.inUse)}</Table.Td>
                      <Table.Td ta="right">{formatCount(stats.available)}</Table.Td>
                      <Table.Td ta="right">{formatCount(stats.created)}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Section>
          </>
        )}
      </LoadState>
    </Stack>
  );
}
