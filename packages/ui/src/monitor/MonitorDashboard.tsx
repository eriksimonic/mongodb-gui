import {
  Alert,
  Button,
  Group,
  useComputedColorScheme,
  Modal,
  Paper,
  SegmentedControl,
  Stack,
  Text,
} from '@mantine/core';
import { connectionTopologyLabel } from '../connections';
import {
  DEFAULT_MONITOR_INTERVAL_MS,
  findPanel,
  type ConnectionStatus,
  type MonitorSample,
  type PanelSpec,
  type SeriesUnit,
  type ServerCapabilities,
} from '@mongo-gui/core';
import { Fragment, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { layoutPanelIds, ROW_MIN_HEIGHT_PX, type DashboardLayout } from '@mongo-gui/core';
import { runReported } from '../kit/notify-error';
import { useAppStore } from '../state/app-store-context';
import { EMPTY_MONITOR_VIEW } from '../state/monitor-state';
import {
  EMPTY_DASHBOARD_VIEW,
  setRowHeight,
  splitPanels,
  visibleRows,
  type DropPlace,
} from '../state/dashboard-state';
import { chartSeries } from './chart-series';
import type { ChartMode, ChartWindow } from './chart-types';
import { AddPanelPicker } from './AddPanelPicker';
import { ChartBody, PanelCard, PanelMenu, StatBody } from './PanelCard';
import { trackOffset } from './track-offset';
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
    <Paper withBorder p="sm" radius="md" bg="var(--mg-surface-1)">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <Text fz={24} fw={600} lh={1.3} style={{ fontVariantNumeric: 'tabular-nums' }}>
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
      return `MongoDB ${status.serverVersion} · ${connectionTopologyLabel(status)}`;
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
  const splitDashboardPanels = useAppStore((state) => state.splitDashboardPanels);
  const setDashboardRowHeight = useAppStore((state) => state.setDashboardRowHeight);
  const resetDashboard = useAppStore((state) => state.resetDashboard);
  const [range, setRange] = useState<MonitorRange>('5m');
  const [frozen, setFrozen] = useState<readonly MonitorSample[] | undefined>(undefined);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [aboutId, setAboutId] = useState<string | undefined>(undefined);
  // A resize shows through `preview` and commits to the store when the pointer is released.
  const [preview, setPreview] = useState<
    ((layout: DashboardLayout) => DashboardLayout) | undefined
  >(undefined);
  const [drag, setDrag] = useState<
    { id: string; target?: { id: string; place: DropPlace } } | undefined
  >(undefined);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [areaWidth, setAreaWidth] = useState(0);

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
  const shownLayout = useMemo(
    () => (preview === undefined ? layout : preview(layout)),
    [layout, preview],
  );
  const rows = useMemo(
    () => visibleRows(shownLayout, { wiredTiger, replicaSet }),
    [shownLayout, wiredTiger, replicaSet],
  );
  // Narrow windows show every panel as its own full-width row. The saved layout stays as it is.
  const narrow = areaWidth > 0 && areaWidth < NARROW_PX;
  const shownRows = useMemo(
    () =>
      narrow
        ? rows.flatMap((row) =>
            row.panels.map((panel) => ({
              index: row.index,
              h: row.h,
              panels: [{ ...panel, f: 1 }],
            })),
          )
        : rows,
    [rows, narrow],
  );
  const panelCount = rows.length;
  const addedIds = useMemo(() => new Set(layoutPanelIds(layout)), [layout]);
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

  function cardWidth(id: string): number {
    return (
      canvasRef.current?.querySelector(`[data-panel-id="${id}"]`)?.getBoundingClientRect().width ??
      0
    );
  }

  /** Moves the boundary between two neighbours, and the row height when `h` is given. */
  function resize(
    leftId: string,
    rightId: string | undefined,
    rowIndex: number,
    startH: number,
    dx: number,
    dy: number,
    final: boolean,
    startLeft: number,
    startPair: number,
  ): void {
    const min = Math.min(MIN_PANEL_PX, startPair / 2);
    const share =
      rightId === undefined || startPair === 0
        ? undefined
        : Math.min(startPair - min, Math.max(min, startLeft + dx)) / startPair;
    const height = Math.max(ROW_MIN_HEIGHT_PX, startH + dy);
    const change = (current: DashboardLayout): DashboardLayout => {
      const split =
        share === undefined || rightId === undefined
          ? current
          : splitPanels(current, leftId, rightId, share);
      return setRowHeight(split, rowIndex, height);
    };
    if (final) {
      setPreview(undefined);
      if (share !== undefined && rightId !== undefined) {
        splitDashboardPanels(connectionId, leftId, rightId, share);
      }
      setDashboardRowHeight(connectionId, rowIndex, height);
    } else {
      setPreview(() => change);
    }
  }

  /** The panel and the side of it under the pointer while a header is dragged. */
  function dropTargetAt(
    id: string,
    x: number,
    y: number,
  ): { id: string; place: DropPlace } | undefined {
    for (const element of document.elementsFromPoint(x, y)) {
      const card = element.closest('[data-panel-id]');
      const targetId = card?.getAttribute('data-panel-id');
      if (
        card !== null &&
        card !== undefined &&
        targetId !== null &&
        targetId !== undefined &&
        targetId !== id
      ) {
        const box = card.getBoundingClientRect();
        const fx = (x - box.left) / box.width;
        const fy = (y - box.top) / box.height;
        const place: DropPlace =
          fy < 0.25 ? 'above' : fy > 0.75 ? 'below' : fx < 0.5 ? 'left' : 'right';
        return { id: targetId, place };
      }
    }
    return undefined;
  }

  function moveHeader(id: string, x: number, y: number, final: boolean): void {
    const target = dropTargetAt(id, x, y);
    if (final) {
      setDrag(undefined);
      if (target !== undefined) {
        moveDashboardPanel(connectionId, id, target.id, target.place);
      }
    } else {
      setDrag({ id, ...(target === undefined ? {} : { target }) });
    }
  }

  useEffect(() => {
    const element = canvasRef.current;
    if (element === null) {
      return undefined;
    }
    setAreaWidth(Math.floor(element.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      setAreaWidth(Math.floor(entries[0]?.contentRect.width ?? 0));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [panelCount === 0, windowed.length === 0]);

  return (
    <Stack
      gap="sm"
      p="md"
      data-testid="monitor-dashboard"
      h="100%"
      style={{ minHeight: 0, overflow: 'auto' }}
    >
      <Group justify="space-between" align="flex-start" wrap="wrap" gap={8}>
        <Stack gap={0}>
          <Text fw={600} size="md">
            {connectionName ?? 'Connection'}
          </Text>
          <Text size="xs" c="dimmed">
            {frozen === undefined ? subtitle : `${subtitle} · Paused`}
          </Text>
        </Stack>
        <Group gap={8} wrap="wrap">
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
        <Stack gap={8}>
          <div className="mg-kpi-grid">
            {tiles.map((tile) => (
              <StatTile key={tile.label} label={tile.label} value={tile.value} />
            ))}
          </div>

          {panelCount === 0 ? (
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
            <div className="mg-panel-canvas" data-testid="panel-grid" ref={canvasRef}>
              {shownRows.map((row, rowPosition) => (
                <div key={`${row.index}-${row.panels[0]?.id ?? ''}`} className="mg-panel-row-wrap">
                  <div className="mg-panel-row" style={{ height: row.h }}>
                    {row.panels.map(({ id, spec, f }, position) => {
                      const next = row.panels[position + 1];
                      const title = spec.title;
                      const menu = (
                        <PanelMenu
                          title={title}
                          onClose={() => removeDashboardPanel(connectionId, id)}
                          onAbout={() => setAboutId(id)}
                        />
                      );
                      const firstUnit = spec.series[0]?.unit;
                      // A stat panel shows one series. Its value comes from the newest sample.
                      const statSeries = spec.chart === 'stat' ? spec.series[0] : undefined;
                      const startResize = (
                        event: PointerEvent<HTMLElement>,
                        withHeight: boolean,
                      ) => {
                        const startLeft = cardWidth(id);
                        const startPair = startLeft + (next === undefined ? 0 : cardWidth(next.id));
                        trackOffset(event, (dx, dy, final) =>
                          resize(
                            id,
                            narrow ? undefined : next?.id,
                            row.index,
                            row.h,
                            dx,
                            withHeight ? dy : 0,
                            final,
                            startLeft,
                            startPair,
                          ),
                        );
                      };
                      return (
                        <Fragment key={id}>
                          <div className="mg-panel-slot" style={{ flex: `${f} 1 0` }}>
                            <PanelCard
                              id={id}
                              title={title}
                              caption={firstUnit === undefined ? '' : unitCaption(firstUnit)}
                              dragging={drag?.id === id}
                              dropPlace={drag?.target?.id === id ? drag.target.place : undefined}
                              menu={menu}
                              onMove={(x, y, final) => moveHeader(id, x, y, final)}
                            >
                              {statSeries === undefined ? (
                                <PanelChartBody
                                  spec={spec}
                                  timeline={timeline}
                                  mode={chartModeOf(spec)}
                                  syncKey={syncKey}
                                  chartWindow={chartWindow}
                                  yUnit={firstUnit ?? 'count'}
                                />
                              ) : (
                                <StatBody
                                  value={latestSeriesValue(windowed, statSeries)}
                                  unit={statSeries.unit}
                                />
                              )}
                            </PanelCard>
                          </div>
                          {next === undefined || narrow ? null : (
                            <div
                              className="mg-divider mg-divider-v"
                              role="separator"
                              aria-orientation="vertical"
                              aria-label={`Resize ${title} and ${next.spec.title}`}
                              onPointerDown={(event) => startResize(event, false)}
                            />
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                  <div
                    className="mg-divider mg-divider-h"
                    role="separator"
                    aria-orientation="horizontal"
                    aria-label="Resize row height"
                    data-last={rowPosition === shownRows.length - 1 ? 'true' : undefined}
                    onPointerDown={(event) =>
                      trackOffset(event, (_dx, dy, final) =>
                        resize('', undefined, row.index, row.h, 0, dy, final, 0, 0),
                      )
                    }
                  />
                </div>
              ))}
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

/** Below this width every panel is its own row, and the dividers go. */
const NARROW_PX = 720;
/** The least width a panel keeps when a divider is dragged. */
const MIN_PANEL_PX = 240;

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
  readonly yUnit: SeriesUnit;
}

/** A chart panel's body, with its lines built from the catalogue entry. */
function PanelChartBody({
  spec,
  timeline,
  mode,
  syncKey,
  chartWindow,
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
      emptyText="No samples in this range."
    />
  );
}
