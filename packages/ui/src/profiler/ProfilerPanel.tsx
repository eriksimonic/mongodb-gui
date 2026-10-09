import { Alert, Box, Button, Flex, Stack, Tabs, Text } from '@mantine/core';
import { useEffect, useMemo, useRef } from 'react';
import { useAppStore } from '../state/app-store-context';
import { catalogKey, profilerPanelId } from '../state/node-ids';
import { ProfilerDetail } from './ProfilerDetail';
import { ProfilerFilterRow } from './ProfilerFilters';
import { ProfilerHeader } from './ProfilerHeader';
import { ShapesTable } from './ShapesTable';
import { SlowQueryTable } from './SlowQueryTable';
import { useProfilerStore } from './profiler-store-context';
import type { ProfilerPanelState, ProfilerSeed } from './profiler-store';
import { entriesOfShape, sortEntries } from './profiler-model';
import './profiler.css';

const MIN_DETAIL_WIDTH = 240;
const MAX_DETAIL_WIDTH = 800;

export interface ProfilerPanelProps {
  readonly connectionId: string;
  readonly database: string;
  /** Startup values for stories and tests. The panel reads them once, when it opens. */
  readonly seed?: ProfilerSeed | undefined;
}

/**
 * The profiler of one database: level control, filters, the slow query table with its detail
 * pane, and the top shapes view. The panel opens its state on mount and drops it on unmount,
 * which also stops its tail.
 */
export function ProfilerPanel({ connectionId, database, seed }: ProfilerPanelProps) {
  const panelId = profilerPanelId(connectionId, database);
  const open = useProfilerStore((state) => state.open);
  const close = useProfilerStore((state) => state.close);
  const panel = useProfilerStore((state) => state.panels[panelId]);
  const loadCollections = useAppStore((state) => state.loadCollections);
  const collections = useAppStore((state) => state.collections[catalogKey(connectionId, database)]);
  const seedRef = useRef(seed);

  useEffect(() => {
    void open(panelId, connectionId, database, seedRef.current);
    void loadCollections(connectionId, database);
    return () => {
      void close(panelId);
    };
  }, [panelId, connectionId, database, open, close, loadCollections]);

  const namespaces = useMemo(
    () =>
      collections?.state === 'ready'
        ? collections.data.map((collection) => `${database}.${collection.name}`)
        : [],
    [collections, database],
  );

  if (panel === undefined) {
    return (
      <Text size="sm" c="dimmed" p={8}>
        Opening the profiler
      </Text>
    );
  }

  return (
    <ProfilerBody
      panelId={panelId}
      connectionId={connectionId}
      database={database}
      namespaces={namespaces}
      panel={panel}
    />
  );
}

interface ProfilerBodyProps {
  readonly panelId: string;
  readonly connectionId: string;
  readonly database: string;
  readonly namespaces: readonly string[];
  readonly panel: ProfilerPanelState;
}

function ProfilerBody({ panelId, connectionId, database, namespaces, panel }: ProfilerBodyProps) {
  const setTab = useProfilerStore((state) => state.setTab);
  const setShapeFilter = useProfilerStore((state) => state.setShapeFilter);
  const select = useProfilerStore((state) => state.select);
  const sortBy = useProfilerStore((state) => state.sortBy);
  const setDetailWidth = useProfilerStore((state) => state.setDetailWidth);

  const visible = useMemo(() => {
    const rows =
      panel.shapeFilter === undefined
        ? panel.entries
        : entriesOfShape(panel.entries, panel.shapeFilter);
    return sortEntries(rows, panel.sort);
  }, [panel.entries, panel.shapeFilter, panel.sort]);
  const selected = panel.entries.find((entry) => entry.id === panel.selectedId);

  function changeTab(value: string | null) {
    if (value === 'slow' || value === 'shapes') {
      setTab(panelId, value);
    }
  }

  function resizeDetail(width: number) {
    setDetailWidth(panelId, Math.min(MAX_DETAIL_WIDTH, Math.max(MIN_DETAIL_WIDTH, width)));
  }

  return (
    <Stack gap={8} h="100%" p={8} style={{ minHeight: 0 }}>
      <ProfilerHeader panelId={panelId} panel={panel} />
      <ProfilerFilterRow panelId={panelId} panel={panel} namespaces={namespaces} />
      {panel.error === undefined ? null : (
        <Alert color="red" variant="light" title="The profiler could not load" p="xs">
          {panel.error.message}
        </Alert>
      )}
      <Tabs value={panel.tab} onChange={changeTab} keepMounted={false}>
        <Tabs.List>
          <Tabs.Tab value="slow">Slow queries</Tabs.Tab>
          <Tabs.Tab value="shapes">Top shapes</Tabs.Tab>
        </Tabs.List>
      </Tabs>
      {panel.tab === 'shapes' ? (
        <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <ShapesTable shapes={panel.shapes} onSelect={(key) => setShapeFilter(panelId, key)} />
        </Box>
      ) : (
        <Flex style={{ flex: 1, minHeight: 0 }} gap={0}>
          <Box style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
            {panel.shapeFilter === undefined ? null : (
              <Alert color="blue" variant="light" p="xs" mb={6}>
                <Flex justify="space-between" align="center" gap={8}>
                  <Text size="xs" truncate>
                    Showing the operations of one query shape
                  </Text>
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => setShapeFilter(panelId, undefined)}
                  >
                    Clear shape filter
                  </Button>
                </Flex>
              </Alert>
            )}
            <SlowQueryTable
              entries={visible}
              selectedId={panel.selectedId}
              highlighted={panel.highlighted}
              sort={panel.sort}
              loading={panel.loading}
              level={panel.level?.level}
              onSelect={(id) => select(panelId, id)}
              onSort={(key) => sortBy(panelId, key)}
            />
          </Box>
          <ProfilerDetail
            connectionId={connectionId}
            database={database}
            entry={selected}
            width={panel.detailWidth}
            onResize={resizeDetail}
          />
        </Flex>
      )}
    </Stack>
  );
}
