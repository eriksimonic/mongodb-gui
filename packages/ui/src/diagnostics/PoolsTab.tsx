import { Box, SimpleGrid, Table } from '@mantine/core';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { StatCard } from '../kit/StatCard';
import { LoadState, ScrollLayout, Toolbar } from './common';
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
    <ScrollLayout toolbar={<Toolbar loading={state.loading} onRefresh={() => void load()} />}>
      <LoadState state={state}>
        {(pools) => (
          <>
            <SimpleGrid cols={3} spacing="sm">
              <StatCard label="In use" value={formatCount(pools.totalInUse)}>
                across {Object.keys(pools.hosts).length}{' '}
                {Object.keys(pools.hosts).length === 1 ? 'host' : 'hosts'}
              </StatCard>
              <StatCard label="Available" value={formatCount(pools.totalAvailable)}>
                idle and ready
              </StatCard>
              <StatCard label="Created" value={formatCount(pools.totalCreated)}>
                since start
              </StatCard>
            </SimpleGrid>
            <Table withTableBorder verticalSpacing={6} fz="sm">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>Host</Table.Th>
                  <Table.Th w={220}>Use</Table.Th>
                  <Table.Th ta="right">In use</Table.Th>
                  <Table.Th ta="right">Available</Table.Th>
                  <Table.Th ta="right">Created</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {Object.entries(pools.hosts).map(([host, stats]) => (
                  <Table.Tr key={host}>
                    <Table.Td style={{ fontFamily: 'var(--mantine-font-family-monospace)' }}>
                      {host}
                    </Table.Td>
                    <Table.Td>
                      <UseBar inUse={stats.inUse} available={stats.available} />
                    </Table.Td>
                    <Table.Td ta="right">{formatCount(stats.inUse)}</Table.Td>
                    <Table.Td ta="right">{formatCount(stats.available)}</Table.Td>
                    <Table.Td ta="right">{formatCount(stats.created)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </>
        )}
      </LoadState>
    </ScrollLayout>
  );
}

/** A bar of the connections in use against the connections the pool holds. */
function UseBar({ inUse, available }: { readonly inUse: number; readonly available: number }) {
  const total = inUse + available;
  const share = total > 0 ? Math.round((inUse / total) * 100) : 0;
  return (
    <Box
      h={6}
      style={{ background: 'var(--mg-surface-3)', borderRadius: 3 }}
      role="img"
      aria-label={`${share}% in use`}
    >
      <Box h={6} w={`${share}%`} style={{ background: 'var(--mg-accent)', borderRadius: 3 }} />
    </Box>
  );
}
