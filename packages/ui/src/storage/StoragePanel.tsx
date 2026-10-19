import {
  Alert,
  Anchor,
  Box,
  Breadcrumbs,
  Group,
  Loader,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import type { StorageCollection, StorageCollections } from '@mongo-gui/core';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { useStore } from 'zustand';
import { useUiApi } from '../api/ui-api';
import { RefreshButton } from '../diagnostics/common';
import { formatCount } from '../diagnostics/format';
import { IndexBar, type IndexBarItem } from './IndexBar';
import { DiskStrip } from './DiskStrip';
import { InsightCards } from './InsightCards';
import { computeInsights, type TaggedCollection } from './insights';
import { fillFor } from './tones';
import { StorageTable, type StorageTableLevel, type StorageTableRow } from './StorageTable';
import { createStorageStore, type StorageRead } from './storage-store';

export type StorageMetric = 'storage' | 'data' | 'index';

/** Where the user drilled. No database means the server level. */
export interface StorageDrill {
  readonly database?: string | undefined;
  readonly collection?: string | undefined;
}

export interface StoragePanelProps {
  readonly connectionId: string;
  /** Opens focused on this database, from the database row menu. */
  readonly focusDatabase?: string | undefined;
}

const METRIC_OPTIONS: { value: StorageMetric; label: string }[] = [
  { value: 'storage', label: 'Storage size' },
  { value: 'data', label: 'Data size' },
  { value: 'index', label: 'Index size' },
];

/** The size a collection tile shows for the chosen metric. */
function metricBytes(collection: StorageCollection, metric: StorageMetric): number {
  switch (metric) {
    case 'data':
      return collection.dataSize;
    case 'index':
      return collection.totalIndexSize;
    default:
      return collection.storageSize;
  }
}

/** A share of a whole, or null when the whole is zero. */
function share(part: number, whole: number): number | null {
  return whole > 0 ? part / whole : null;
}

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** One storage panel for a connection. Shows one table, with an index bar on top at the index level, drilled from databases to indexes. */
export function StoragePanel({ connectionId, focusDatabase }: StoragePanelProps) {
  const { rpc } = useUiApi();
  const [store] = useState(() => createStorageStore({ connectionId }, rpc.diagnostics));
  const [drill, setDrill] = useState<StorageDrill>({ database: focusDatabase });
  const [metric, setMetric] = useState<StorageMetric>('storage');
  const [filter, setFilter] = useState('');
  const databases = useStore(store, (state) => state.databases);
  const collections = useStore(store, (state) => state.collections);
  const loadDatabases = useStore(store, (state) => state.loadDatabases);
  const loadCollections = useStore(store, (state) => state.loadCollections);
  const refresh = useStore(store, (state) => state.refresh);

  useEffect(() => {
    void loadDatabases();
  }, [loadDatabases]);

  useEffect(() => {
    if (drill.database !== undefined) {
      void loadCollections(drill.database);
    }
  }, [drill.database, loadCollections]);

  const databaseList = databases.data?.databases ?? [];
  const current: StorageRead<StorageCollections> | undefined =
    drill.database === undefined ? undefined : collections[drill.database];
  const collectionList = current?.data?.collections ?? [];
  const selected = collectionList.find((collection) => collection.name === drill.collection);
  const level: StorageTableLevel =
    drill.database === undefined ? 'databases' : selected === undefined ? 'collections' : 'indexes';
  const read = level === 'databases' ? databases : current;
  const loading = databases.loading || (current?.loading ?? false);

  const needle = filter.trim().toLowerCase();
  const visible = (name: string) => needle === '' || name.toLowerCase().includes(needle);

  // Collections whose read failed have no real numbers, so the insight cards leave them out.
  const loaded: TaggedCollection[] = useMemo(
    () =>
      Object.entries(collections)
        .filter(([database]) => database === drill.database)
        .flatMap(([database, collectionRead]) =>
          (collectionRead.data?.collections ?? [])
            .filter((collection) => collection.error === null)
            .map((collection) => ({ ...collection, database })),
        ),
    [collections, drill.database],
  );
  const hasLoaded = current?.data !== undefined;
  const insights = useMemo(() => computeInsights(loaded), [loaded]);
  const unknownOps = loaded
    .flatMap((collection) => collection.indexes)
    .filter((index) => index.ops === null).length;

  const barWhole = selected === undefined ? 0 : selected.dataSize + selected.totalIndexSize;
  const barItems: IndexBarItem[] =
    level === 'indexes' && selected !== undefined
      ? [
          { id: 'data', label: 'Data', bytes: selected.dataSize, tone: 'data' },
          ...((selected.freeStorageSize ?? 0) > 0
            ? [
                {
                  id: 'free',
                  label: 'Free space',
                  bytes: selected.freeStorageSize ?? 0,
                  tone: 'free' as const,
                },
              ]
            : []),
          ...selected.indexes
            .filter((index) => visible(index.name))
            .sort((a, b) => b.size - a.size)
            .map((index): IndexBarItem => ({
              id: `index:${index.name}`,
              label: index.name,
              bytes: index.size,
              tone: 'index',
              extra: [
                `Operations: ${index.ops === null ? 'could not check' : formatCount(index.ops)}`,
              ],
            })),
        ]
      : [];

  const dotFor = (name: string) => {
    const position = barItems.findIndex((item) => item.id === `index:${name}`);
    const item = barItems[position];
    return item === undefined ? undefined : fillFor(item, position, false);
  };

  const { rows, onRowActivate } = buildView();

  const databaseBytes = databaseList.reduce((sum, database) => sum + database.sizeOnDisk, 0);
  const totalBytes = databases.data?.fsTotalSize ?? null;

  const crumbs: { label: string; target: StorageDrill }[] = [{ label: 'Server', target: {} }];
  if (drill.database !== undefined) {
    crumbs.push({ label: drill.database, target: { database: drill.database } });
  }
  if (level === 'indexes' && selected !== undefined) {
    crumbs.push({
      label: selected.name,
      target: { database: drill.database, collection: selected.name },
    });
  }

  // Backspace goes up one level. Typing in the filter box keeps its own Backspace.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Backspace' || event.target instanceof HTMLInputElement) {
      return;
    }
    if (drill.collection !== undefined) {
      setDrill({ database: drill.database });
    } else if (drill.database !== undefined) {
      setDrill({});
    }
  };

  function buildView(): {
    rows: StorageTableRow[];
    onRowActivate: ((id: string) => void) | undefined;
  } {
    if (level === 'databases') {
      const shown = databaseList.filter((database) => visible(database.name));
      return {
        rows: shown.map((database): StorageTableRow => ({
          id: database.name,
          error: undefined,
          cells: {
            name: database.name,
            bar: database.sizeOnDisk,
            state: database.empty ? 'empty' : 'has data',
          },
        })),
        onRowActivate: (id) => setDrill({ database: id }),
      };
    }

    if (level === 'collections') {
      const shown = collectionList.filter((collection) => visible(collection.name));
      return {
        rows: shown.map((collection): StorageTableRow => ({
          id: collection.name,
          error: collection.error ?? undefined,
          cells: {
            name: collection.name,
            bar: metricBytes(collection, metric),
            count: collection.count,
            avgObjSize: collection.avgObjSize,
            dataSize: collection.dataSize,
            storageSize: collection.storageSize,
            freeStorageSize: collection.freeStorageSize,
            totalIndexSize: collection.totalIndexSize,
            indexShare: share(
              collection.totalIndexSize,
              collection.dataSize + collection.totalIndexSize,
            ),
            compression: share(collection.dataSize, collection.storageSize),
          },
        })),
        onRowActivate: (id) => setDrill({ database: drill.database, collection: id }),
      };
    }

    // Index level. Shows the collection data, its free space and each index.
    if (selected === undefined) {
      return { rows: [], onRowActivate: undefined };
    }
    // Every share on this level and the collection table uses data plus index size as the base.
    // Free space is left out of the base.
    const whole = selected.dataSize + selected.totalIndexSize;
    const shownIndexes = selected.indexes.filter((index) => visible(index.name));
    return {
      rows: shownIndexes.map((index): StorageTableRow => ({
        id: index.name,
        error: undefined,
        dot: dotFor(index.name),
        cells: {
          name: index.name,
          size: index.size,
          share: share(index.size, whole),
          ops: index.ops,
          since: index.since,
        },
      })),
      onRowActivate: undefined,
    };
  }

  const emptyText =
    needle !== ''
      ? 'No name matches the filter.'
      : level === 'databases'
        ? 'This server reports no databases.'
        : 'Nothing to show at this level.';

  return (
    <Stack h="100%" gap="md" p="lg" style={{ overflow: 'auto' }} onKeyDown={onKeyDown}>
      <Group justify="space-between" wrap="wrap" gap="sm">
        <Breadcrumbs separator=">">
          {crumbs.map((crumb, index) =>
            index === crumbs.length - 1 ? (
              <Text key={`${index}:${crumb.label}`} size="sm" fw={500}>
                {crumb.label}
              </Text>
            ) : (
              <Anchor
                key={`${index}:${crumb.label}`}
                component="button"
                type="button"
                size="sm"
                onClick={() => setDrill(crumb.target)}
              >
                {crumb.label}
              </Anchor>
            ),
          )}
        </Breadcrumbs>
        <Group gap="sm" wrap="wrap">
          {level === 'collections' ? (
            <SegmentedControl
              size="xs"
              value={metric}
              onChange={(value) => setMetric(value as StorageMetric)}
              data={METRIC_OPTIONS}
            />
          ) : null}
          <TextInput
            size="xs"
            placeholder="Filter names"
            aria-label="Filter names"
            value={filter}
            onChange={(event) => setFilter(event.currentTarget.value)}
          />
          <RefreshButton loading={loading} onRefresh={() => void refresh(drill.database)} />
          {read?.loadedAt === undefined ? null : (
            <Text size="xs" c="dimmed">
              Loaded at {clock(read.loadedAt)}
            </Text>
          )}
        </Group>
      </Group>

      {totalBytes === null ? null : (
        <DiskStrip
          totalBytes={totalBytes}
          usedBytes={databases.data?.fsUsedSize ?? null}
          databaseBytes={databaseBytes}
        />
      )}

      {level === 'databases' ? null : (
        <InsightCards insights={insights} unknownOps={unknownOps} hasLoaded={hasLoaded} />
      )}

      {read?.error === undefined ? null : (
        <Alert color="red" variant="light">
          {read.error}
        </Alert>
      )}

      {read?.data === undefined ? (
        read?.error === undefined ? (
          <Loader size="sm" />
        ) : null
      ) : rows.length === 0 ? (
        <Text c="dimmed" size="sm">
          {emptyText}
        </Text>
      ) : (
        <Stack gap="md" style={{ flex: 1, minHeight: 0 }}>
          {level === 'indexes' ? <IndexBar items={barItems} whole={barWhole} /> : null}
          <Box
            style={{
              flex: 1,
              minHeight: 240,
              border: '1px solid var(--mg-border)',
              borderRadius: 6,
              overflow: 'hidden',
            }}
          >
            <StorageTable
              level={level}
              rows={rows}
              onRowActivate={onRowActivate}
              sizeKey={metric}
            />
          </Box>
        </Stack>
      )}
    </Stack>
  );
}
