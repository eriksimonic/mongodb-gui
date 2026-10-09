import { Alert, Box, Button, Checkbox, Flex, Menu, Stack, Tabs, Text } from '@mantine/core';
import { useCallback, useEffect, useMemo, useRef } from 'react';
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
  const setColumn = useProfilerStore((state) => state.setColumn);

  const visible = useMemo(() => {
    const rows =
      panel.shapeFilter === undefined
        ? panel.entries
        : entriesOfShape(panel.entries, panel.shapeFilter);
    return sortEntries(rows, panel.sort);
  }, [panel.entries, panel.shapeFilter, panel.sort]);
  const highlighted = useMemo(() => new Set(panel.highlighted), [panel.highlighted]);
  const selected = panel.entries.find((entry) => entry.id === panel.selectedId);

  // Stable callbacks, so memoised table rows do not re-render on unrelated store updates.
  const onSelect = useCallback((id: string) => select(panelId, id), [select, panelId]);
  const onSort = useCallback((key: 'time' | 'duration') => sortBy(panelId, key), [sortBy, panelId]);

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
      <Flex justify="space-between" align="flex-end" gap={8}>
        <Tabs value={panel.tab} onChange={changeTab} keepMounted={false} style={{ flex: 1 }}>
          <Tabs.List>
            <Tabs.Tab value="slow">Slow queries</Tabs.Tab>
            <Tabs.Tab value="shapes">Top shapes</Tabs.Tab>
          </Tabs.List>
        </Tabs>
        {panel.tab === 'slow' ? (
          <Menu closeOnItemClick={false} position="bottom-end" shadow="md" withinPortal>
            <Menu.Target>
              <Button size="xs" variant="default">
                Columns
              </Button>
            </Menu.Target>
            <Menu.Dropdown>
              <Stack gap={6} p={8}>
                <Checkbox
                  label="Client or app"
                  checked={panel.columns.client}
                  onChange={(event) => setColumn(panelId, 'client', event.currentTarget.checked)}
                />
                <Checkbox
                  label="Error"
                  checked={panel.columns.error}
                  onChange={(event) => setColumn(panelId, 'error', event.currentTarget.checked)}
                />
              </Stack>
            </Menu.Dropdown>
          </Menu>
        ) : null}
      </Flex>
      {panel.tab === 'shapes' ? (
        <Box style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <ShapesTable shapes={panel.shapes} onSelect={(key) => setShapeFilter(panelId, key)} />
        </Box>
      ) : (
        <Flex style={{ flex: 1, minHeight: 0 }} gap={0}>
          <Flex direction="column" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
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
            <Box style={{ flex: 1, minHeight: 0 }}>
              <SlowQueryTable
                entries={visible}
                selectedId={panel.selectedId}
                highlighted={highlighted}
                sort={panel.sort}
                loading={panel.loading}
                level={panel.level?.level}
                columns={panel.columns}
                onSelect={onSelect}
                onSort={onSort}
              />
            </Box>
          </Flex>
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
