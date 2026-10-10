import {
  Alert,
  Button,
  Group,
  useComputedColorScheme,
  Modal,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import {
  DEFAULT_MONITOR_INTERVAL_MS,
  findPanel,
  type ConnectionStatus,
  type MonitorSample,
  type PanelSpec,
  type SeriesUnit,
  type ServerCapabilities,
} from '@mongo-gui/core';
import { useEffect, useMemo, useState } from 'react';
import { runReported } from '../components/notify-error';
import { useAppStore } from '../state/app-store-context';
import { EMPTY_MONITOR_VIEW } from '../state/monitor-state';
import { EMPTY_DASHBOARD_VIEW, visiblePanels } from '../state/dashboard-state';
import { chartSeries } from './chart-series';
import type { ChartMode, ChartWindow } from './chart-types';
import { AddPanelPicker } from './AddPanelPicker';
import { ChartBody, PanelCard, PanelMenu, StatBody } from './PanelCard';
import { formatCompact, formatDuration, formatExact, formatInterval, unitCaption } from './format';
import {
  headlineOf,
  latestSeriesValue,
  MONITOR_RANGES,
  panelLines,
  RANGE_LABELS,
  RANGE_MS,
  RANGE_TICK_SECONDS,
  rangeSamples,
  timelineOf,
  type MonitorRange,
  type Timeline,
} from './series';
import './monitor.css';

const DISCONNECTED: ConnectionStatus = { state: 'disconnected' };
const SAMPLING_INTERVALS_MS = [1000, 2000, 5000, 10_000] as const;

const RANGE_OPTIONS = MONITOR_RANGES.map((range) => ({ value: range, label: RANGE_LABELS[range] }));
const INTERVAL_OPTIONS = SAMPLING_INTERVALS_MS.map((intervalMs) => ({
  value: String(intervalMs),
  label: formatInterval(intervalMs),
}));

export interface MonitorDashboardProps {
  readonly connectionId: string;
}

interface StatTileProps {
  readonly label: string;
  readonly value: string;
}

function StatTile({ label, value }: StatTileProps) {
  return (
    <Paper withBorder p="sm" radius="sm">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fz={22} fw={600} lh={1.3}>
        {value}
      </Text>
    </Paper>
  );
}

function statusSummary(status: ConnectionStatus): { title: string; message: string } {
  switch (status.state) {
    case 'connecting':
      return { title: 'Connecting', message: 'Monitoring starts when the connection opens.' };
    case 'error':
      return { title: 'Connection failed', message: status.error.message };
    default:
      return {
        title: 'The connection is disconnected',
        message: 'Connect to resume monitoring. The charts show the last samples.',
      };
  }
}

/** Short header line. It shows the server version and topology when open, and the state otherwise. */
function headerSubtitle(status: ConnectionStatus): string {
  switch (status.state) {
    case 'connected':
      return `MongoDB ${status.serverVersion} · ${status.topology}`;
    case 'connecting':
      return 'Connecting';
    case 'error':
      return 'Connection failed';
    default:
      return 'Not connected';
  }
}

/**
 * What the connected server offers, read from the status and the newest sample. Unknown values
 * never disable a panel, so a panel stays available until the server says it cannot run.
 */
function capabilitiesOf(
  status: ConnectionStatus,
  latest: MonitorSample | undefined,
): ServerCapabilities {
  return {
    wiredTiger: latest === undefined ? undefined : latest.wiredTiger !== undefined,
    replicaSet: status.state === 'connected' ? status.topology === 'replicaSet' : undefined,
  };
}

/**
 * Live server metrics for one connection. The store holds the samples, and this view slices them
 * to the chosen range. Pause freezes the view. Samples keep arriving in the store meanwhile.
 * The panels come from the saved layout of the connection, and each one draws from the catalogue.
 */
export function MonitorDashboard({ connectionId }: MonitorDashboardProps) {
  const connectionName = useAppStore((state) =>
    state.connections.state === 'ready'
      ? state.connections.data.find((item) => item.id === connectionId)?.name
      : undefined,
  );
  const status = useAppStore((state) => state.statuses[connectionId] ?? DISCONNECTED);
  const view = useAppStore((state) => state.monitors[connectionId] ?? EMPTY_MONITOR_VIEW);
  const dashboard = useAppStore((state) => state.dashboards[connectionId] ?? EMPTY_DASHBOARD_VIEW);
  const startMonitor = useAppStore((state) => state.startMonitor);
  const setMonitorInterval = useAppStore((state) => state.setMonitorInterval);
  const retryMonitor = useAppStore((state) => state.retryMonitor);
  const connect = useAppStore((state) => state.connect);
  const loadDashboard = useAppStore((state) => state.loadDashboard);
  const addDashboardPanel = useAppStore((state) => state.addDashboardPanel);
  const removeDashboardPanel = useAppStore((state) => state.removeDashboardPanel);
  const moveDashboardPanel = useAppStore((state) => state.moveDashboardPanel);
  const resizeDashboardPanel = useAppStore((state) => state.resizeDashboardPanel);
  const resetDashboard = useAppStore((state) => state.resetDashboard);
  const [range, setRange] = useState<MonitorRange>('5m');
  const [frozen, setFrozen] = useState<readonly MonitorSample[] | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [aboutId, setAboutId] = useState<string | undefined>(undefined);
  const [dragId, setDragId] = useState<string | undefined>(undefined);

  const connected = status.state === 'connected';
  const running = view.config !== undefined;

  useEffect(() => {
    if (connected && !running) {
      void runReported(() => startMonitor(connectionId));
    }
  }, [connected, running, connectionId, startMonitor]);

  useEffect(() => {
    void loadDashboard(connectionId);
  }, [connectionId, loadDashboard]);

  // While stopped, the selector still shows the interval the user chose, so it matches what a reconnect uses.
  const intervalMs =
    view.config?.intervalMs ?? view.preferredIntervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
  const source = frozen ?? view.samples;
  const windowed = useMemo(() => rangeSamples(source, range), [source, range]);
  const timeline = useMemo(() => timelineOf(windowed, intervalMs), [windowed, intervalMs]);
  const chartWindow = useMemo(
    () => ({ windowSeconds: RANGE_MS[range] / 1000, tickSeconds: RANGE_TICK_SECONDS[range] }),
    [range],
  );
  const capabilities = capabilitiesOf(status, view.samples.at(-1));
  const { wiredTiger, replicaSet } = capabilities;
  const layout = dashboard.layout;
  const panels = useMemo(
    () => visiblePanels(layout, { wiredTiger, replicaSet }),
    [layout, wiredTiger, replicaSet],
  );
  const addedIds = useMemo(() => new Set(layout.panels.map((panel) => panel.id)), [layout]);
  const headline = headlineOf(windowed.at(-1));
  const syncKey = `monitor:${connectionId}`;

  const subtitle = headerSubtitle(status);

  const tiles = [
    {
      label: 'Uptime',
      value:
        headline.uptimeSeconds === undefined ? 'No data' : formatDuration(headline.uptimeSeconds),
    },
    {
      label: 'Current connections',
      value:
        headline.currentConnections === undefined
          ? 'No data'
          : formatCompact(headline.currentConnections),
    },
    {
      label: 'Cache fill',
      value:
        headline.cacheFillPercent === undefined
          ? 'No data'
          : `${headline.cacheFillPercent.toFixed(1)}%`,
    },
    {
      label: 'Operations per second',
      value: headline.opsPerSecond === undefined ? 'No data' : formatExact(headline.opsPerSecond),
    },
    ...(headline.oplogWindowSeconds === undefined
      ? []
      : [{ label: 'Oplog window', value: formatDuration(headline.oplogWindowSeconds) }]),
  ];

  const summary = statusSummary(status);
  const aboutPanel: PanelSpec | undefined = aboutId === undefined ? undefined : findPanel(aboutId);

  function dropOn(targetId: string): void {
    if (dragId !== undefined && dragId !== targetId) {
      moveDashboardPanel(connectionId, dragId, targetId);
    }
    setDragId(undefined);
  }

  return (
    <Stack gap="sm" p="sm" data-testid="monitor-dashboard">
      <Group justify="space-between" align="flex-start" wrap="wrap" gap="xs">
        <Stack gap={0}>
          <Text fw={600} size="md">
            {connectionName ?? 'Connection'}
          </Text>
          <Text size="xs" c="dimmed">
            {frozen === undefined ? subtitle : `${subtitle} · Paused`}
          </Text>
        </Stack>
        <Group gap="xs" wrap="wrap">
          <SegmentedControl
            size="xs"
            data={RANGE_OPTIONS}
            value={range}
            onChange={(value) => {
              const next = MONITOR_RANGES.find((item) => item === value);
              if (next !== undefined) {
                setRange(next);
              }
            }}
          />
          <SegmentedControl
            size="xs"
            data={INTERVAL_OPTIONS}
            value={String(intervalMs)}
            disabled={!running}
            onChange={(value) => {
              void runReported(() => setMonitorInterval(connectionId, Number(value)));
            }}
          />
          <Button
            size="xs"
            variant="default"
            // Resume stays enabled while disconnected, so a frozen view can always be released.
            disabled={!connected && frozen === undefined}
            onClick={() => setFrozen(frozen === undefined ? view.samples : undefined)}
          >
            {frozen === undefined ? 'Pause' : 'Resume'}
          </Button>
          <Button size="xs" variant="light" onClick={() => setPickerOpen(true)}>
            Add panel
          </Button>
          <Button
            size="xs"
            variant="default"
            onClick={() => {
              resetDashboard(connectionId);
            }}
          >
            Reset to default
          </Button>
        </Group>
      </Group>

      {connected ? null : (
        <Alert
          color={status.state === 'error' ? 'red' : 'yellow'}
          variant="light"
          title={summary.title}
        >
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Text size="sm">{summary.message}</Text>
            {status.state === 'connecting' ? null : (
              <Button
                size="xs"
                variant="light"
                onClick={() => void runReported(() => connect(connectionId))}
              >
                Connect
              </Button>
            )}
          </Group>
        </Alert>
      )}

      {view.error === undefined ? null : (
        <Alert color="red" variant="light" title="Sampling failed">
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Stack gap={2}>
              <Text size="sm">{view.error.message}</Text>
              {view.error.detail === undefined ? null : (
                <Text size="xs" c="dimmed">
                  {view.error.detail}
                </Text>
              )}
            </Stack>
            <Button size="xs" variant="light" onClick={() => void retryMonitor(connectionId)}>
              Retry
            </Button>
          </Group>
        </Alert>
      )}

      {dashboard.error === undefined ? null : (
        <Alert color="yellow" variant="light" title="The dashboard layout is not saved">
          <Text size="sm">{dashboard.error.message}</Text>
        </Alert>
      )}

      {dashboard.notice === undefined ? null : (
        <Text size="sm" c="dimmed" data-testid="dashboard-notice">
          {dashboard.notice}
        </Text>
      )}

      <div className="mg-dashboard-frame" data-stale={connected ? 'false' : 'true'}>
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 2, sm: 3, lg: tiles.length }} spacing="xs">
            {tiles.map((tile) => (
              <StatTile key={tile.label} label={tile.label} value={tile.value} />
            ))}
          </SimpleGrid>

          {panels.length === 0 ? (
            <Paper withBorder p="lg" radius="sm" data-testid="dashboard-empty">
              <Stack gap="sm" align="flex-start">
                <Text size="sm">
                  No panels to show. Add a panel, or reset the dashboard to the default panels.
                </Text>
                <Group gap="xs">
                  <Button size="xs" variant="light" onClick={() => setPickerOpen(true)}>
                    Add panel
                  </Button>
                  <Button size="xs" variant="default" onClick={() => resetDashboard(connectionId)}>
                    Reset to default
                  </Button>
                </Group>
              </Stack>
            </Paper>
          ) : windowed.length === 0 ? (
            <Text size="sm" c="dimmed">
              Waiting for the first sample. Sampling runs every {formatInterval(intervalMs)}.
            </Text>
          ) : (
            <div className="mg-panel-grid" data-testid="panel-grid">
              {panels.map(({ placed, spec }, index) => {
                const tall = placed.h === 2;
                const title = spec.title;
                // Moves go past the panels this server hides, which draw nothing, so the neighbours are the visible ones.
                const previous = index > 0 ? panels[index - 1] : undefined;
                const following = panels[index + 1];
                const menu = (
                  <PanelMenu
                    title={title}
                    width={placed.w}
                    tall={tall}
                    onClose={() => removeDashboardPanel(connectionId, placed.id)}
                    onWidth={(width) => resizeDashboardPanel(connectionId, placed.id, { w: width })}
                    onHeight={(next) =>
                      resizeDashboardPanel(connectionId, placed.id, { h: next ? 2 : 1 })
                    }
                    onAbout={() => setAboutId(placed.id)}
                    onMoveLeft={
                      previous === undefined
                        ? undefined
                        : () => moveDashboardPanel(connectionId, placed.id, previous.placed.id)
                    }
                    onMoveRight={
                      following === undefined
                        ? undefined
                        : () => moveDashboardPanel(connectionId, placed.id, following.placed.id)
                    }
                  />
                );
                const firstUnit = spec.series[0]?.unit;
                // A stat panel shows one series. Its value comes from the newest sample.
                const statSeries = spec.chart === 'stat' ? spec.series[0] : undefined;
                return (
                  <PanelCard
                    key={placed.id}
                    id={placed.id}
                    title={title}
                    caption={firstUnit === undefined ? '' : unitCaption(firstUnit)}
                    width={placed.w}
                    tall={tall}
                    dragging={dragId === placed.id}
                    menu={menu}
                    onDragStart={() => setDragId(placed.id)}
                    onDragEnd={() => setDragId(undefined)}
                    onDropHere={() => dropOn(placed.id)}
                  >
                    {statSeries === undefined ? (
                      <PanelChartBody
                        spec={spec}
                        timeline={timeline}
                        mode={chartModeOf(spec)}
                        syncKey={syncKey}
                        chartWindow={chartWindow}
                        tall={tall}
                        yUnit={firstUnit ?? 'count'}
                      />
                    ) : (
                      <StatBody
                        value={latestSeriesValue(windowed, statSeries)}
                        unit={statSeries.unit}
                      />
                    )}
                  </PanelCard>
                );
              })}
            </div>
          )}
        </Stack>
      </div>

      <AddPanelPicker
        opened={pickerOpen}
        onClose={() => setPickerOpen(false)}
        addedIds={addedIds}
        capabilities={capabilities}
        onAdd={(panel) => addDashboardPanel(connectionId, panel)}
      />

      <Modal
        opened={aboutPanel !== undefined}
        onClose={() => setAboutId(undefined)}
        title={aboutPanel?.title ?? 'About this panel'}
        size="md"
        centered
      >
        <Text size="sm">{aboutPanel?.description}</Text>
      </Modal>
    </Stack>
  );
}

function chartModeOf(spec: PanelSpec): ChartMode {
  switch (spec.chart) {
    case 'area':
      return 'area';
    case 'stacked':
      return 'stacked';
    default:
      return 'lines';
  }
}

interface PanelChartBodyProps {
  readonly spec: PanelSpec;
  readonly timeline: Timeline;
  readonly mode: ChartMode;
  readonly syncKey: string;
  readonly chartWindow: ChartWindow;
  readonly tall: boolean;
  readonly yUnit: SeriesUnit;
}

/** A chart panel's body, with its lines built from the catalogue entry. */
function PanelChartBody({
  spec,
  timeline,
  mode,
  syncKey,
  chartWindow,
  tall,
  yUnit,
}: PanelChartBodyProps) {
  const scheme = useComputedColorScheme('dark');
  const series = useMemo(
    () => chartSeries(panelLines(timeline, spec), spec, scheme),
    [timeline, spec, scheme],
  );
  return (
    <ChartBody
      label={`${spec.title}, ${unitCaption(yUnit)}`}
      times={timeline.times}
      series={series}
      yUnit={yUnit}
      mode={mode}
      syncKey={syncKey}
      window={chartWindow}
      tall={tall}
      emptyText="No samples in this range."
    />
  );
}
