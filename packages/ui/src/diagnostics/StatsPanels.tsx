import { Alert, Stack, Table, Text } from '@mantine/core';
import type { CollectionStats } from '@mongo-gui/core';
import { useCallback, useEffect, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import { errorText } from '../components/notify-error';
import { KeyValueTable, RefreshButton, Section } from './common';
import { formatBytes, formatCount } from './format';

export interface DatabaseStatsPanelProps {
  readonly connectionId: string;
  readonly database: string;
}

/** Storage statistics of one database, sizes in readable units. */
export function DatabaseStatsPanel({ connectionId, database }: DatabaseStatsPanelProps) {
  const { rpc } = useUiApi();
  const read = useCallback(
    () => rpc.diagnostics.dbStats({ connectionId, database }),
    [rpc, connectionId, database],
  );
  const { data: stats, loading, error, reload } = useRead(read);

  return (
    <Stack gap="md" p="sm">
      <RefreshButton loading={loading} onRefresh={reload} />
      {error === undefined ? null : (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}
      {stats === undefined ? null : (
        <Section title={`Database ${database}`}>
          <KeyValueTable
            rows={[
              { label: 'Collections', value: formatCount(stats.collections) },
              { label: 'Views', value: formatCount(stats.views) },
              { label: 'Documents', value: formatCount(stats.objects) },
              { label: 'Data size', value: formatBytes(stats.dataSize) },
              { label: 'Storage size', value: formatBytes(stats.storageSize) },
              { label: 'Indexes', value: formatCount(stats.indexes) },
              { label: 'Index size', value: formatBytes(stats.indexSize) },
            ]}
          />
        </Section>
      )}
    </Stack>
  );
}

export interface CollectionStatsPanelProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

/** Storage statistics of one collection, with the size of each index. */
export function CollectionStatsPanel({
  connectionId,
  database,
  collection,
}: CollectionStatsPanelProps) {
  const { rpc } = useUiApi();
  const read = useCallback(
    () => rpc.diagnostics.collStats({ connectionId, database, collection }),
    [rpc, connectionId, database, collection],
  );
  const { data: stats, loading, error, reload } = useRead(read);

  return (
    <Stack gap="md" p="sm">
      <RefreshButton loading={loading} onRefresh={reload} />
      {error === undefined ? null : (
        <Alert color="red" variant="light">
          {error}
        </Alert>
      )}
      {stats === undefined ? null : <CollectionDetail stats={stats} />}
    </Stack>
  );
}

function CollectionDetail({ stats }: { readonly stats: CollectionStats }) {
  const indexes = Object.entries(stats.indexSizes);
  return (
    <>
      <Section title={stats.ns}>
        <KeyValueTable
          rows={[
            { label: 'Documents', value: formatCount(stats.count) },
            { label: 'Data size', value: formatBytes(stats.size) },
            { label: 'Average document size', value: formatBytes(stats.avgObjSize) },
            { label: 'Storage size', value: formatBytes(stats.storageSize) },
            { label: 'Capped', value: stats.capped ? 'Yes' : 'No' },
            { label: 'Indexes', value: formatCount(stats.nindexes) },
            { label: 'Total index size', value: formatBytes(stats.totalIndexSize) },
          ]}
        />
      </Section>
      <Section title="Index sizes">
        {indexes.length === 0 ? (
          <Text size="sm" c="dimmed">
            No indexes.
          </Text>
        ) : (
          <Table withTableBorder verticalSpacing={2} fz="xs" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Index</Table.Th>
                <Table.Th ta="right">Size</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {indexes.map(([name, size]) => (
                <Table.Tr key={name}>
                  <Table.Td style={{ fontFamily: 'monospace' }}>{name}</Table.Td>
                  <Table.Td ta="right">{formatBytes(size)}</Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Section>
    </>
  );
}

interface ReadState<T> {
  readonly data: T | undefined;
  readonly loading: boolean;
  readonly error: string | undefined;
  readonly reload: () => void;
}

interface ReadResult<T> {
  readonly tick: number;
  readonly data: T | undefined;
  readonly error: string | undefined;
}

/** Reads when the inputs change, and again on reload. A failed read keeps the last answer. */
function useRead<T>(read: () => Promise<T>): ReadState<T> {
  const [tick, setTick] = useState(0);
  const [result, setResult] = useState<ReadResult<T> | undefined>(undefined);

  useEffect(() => {
    let current = true;
    read().then(
      (value) => {
        if (current) {
          setResult({ tick, data: value, error: undefined });
        }
      },
      (failure: unknown) => {
        if (current) {
          setResult((previous) => ({ tick, data: previous?.data, error: errorText(failure) }));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [read, tick]);

  return {
    data: result?.data,
    loading: result?.tick !== tick,
    error: result?.error,
    reload: () => setTick((value) => value + 1),
  };
}
