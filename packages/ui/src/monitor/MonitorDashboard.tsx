import {
  Alert,
  Button,
  Group,
  Paper,
  SegmentedControl,
  SimpleGrid,
  Stack,
  Text,
} from '@mantine/core';
import {
  DEFAULT_MONITOR_INTERVAL_MS,
  type ConnectionStatus,
  type MonitorSample,
} from '@mongo-gui/core';
import { useEffect, useMemo, useState } from 'react';
import { runReported } from '../components/notify-error';
import { useAppStore } from '../state/app-store-context';
import { EMPTY_MONITOR_VIEW } from '../state/monitor-state';
import { chartSeries } from './chart-series';
import { ChartCard } from './ChartCard';
import { formatCompact, formatDuration, formatExact, formatInterval } from './format';
import {
  headlineOf,
  MONITOR_RANGES,
  RANGE_LABELS,
  rangeSamples,
  seriesFromSamples,
  type MonitorRange,
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
 * Live server metrics for one connection. The store holds the samples, and this view slices them
 * to the chosen range. Pause freezes the view. Samples keep arriving in the store meanwhile.
 */
export function MonitorDashboard({ connectionId }: MonitorDashboardProps) {
  const connectionName = useAppStore((state) =>
    state.connections.state === 'ready'
      ? state.connections.data.find((item) => item.id === connectionId)?.name
      : undefined,
  );
  const status = useAppStore((state) => state.statuses[connectionId] ?? DISCONNECTED);
  const view = useAppStore((state) => state.monitors[connectionId] ?? EMPTY_MONITOR_VIEW);
  const startMonitor = useAppStore((state) => state.startMonitor);
  const setMonitorInterval = useAppStore((state) => state.setMonitorInterval);
  const retryMonitor = useAppStore((state) => state.retryMonitor);
  const connect = useAppStore((state) => state.connect);
  const [range, setRange] = useState<MonitorRange>('5m');
  const [frozen, setFrozen] = useState<readonly MonitorSample[] | undefined>(undefined);

  const connected = status.state === 'connected';
  const running = view.config !== undefined;

  useEffect(() => {
    if (connected && !running) {
      void runReported(() => startMonitor(connectionId));
    }
  }, [connected, running, connectionId, startMonitor]);

  const source = frozen ?? view.samples;
  const windowed = useMemo(() => rangeSamples(source, range), [source, range]);
  const series = useMemo(() => seriesFromSamples(windowed), [windowed]);
  const cards = useMemo(
    () => ({
      operations: chartSeries(series.operations),
      connections: chartSeries(series.connections),
      network: chartSeries(series.network),
      memory: chartSeries(series.memory),
      queues: chartSeries(series.queues),
      replicationLag: chartSeries(series.replicationLag),
    }),
    [series],
  );
  const headline = headlineOf(windowed.at(-1));
  const intervalMs = view.config?.intervalMs ?? DEFAULT_MONITOR_INTERVAL_MS;
  const hasReplication = windowed.at(-1)?.replication !== undefined;
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
            disabled={!connected}
            onClick={() => setFrozen(frozen === undefined ? view.samples : undefined)}
          >
            {frozen === undefined ? 'Pause' : 'Resume'}
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

      <div className="mg-dashboard-frame" data-stale={connected ? 'false' : 'true'}>
        <Stack gap="sm">
          <SimpleGrid cols={{ base: 2, sm: 3, lg: tiles.length }} spacing="xs">
            {tiles.map((tile) => (
              <StatTile key={tile.label} label={tile.label} value={tile.value} />
            ))}
          </SimpleGrid>

          {windowed.length === 0 ? (
            <Text size="sm" c="dimmed">
              Waiting for the first sample. Sampling runs every {formatInterval(intervalMs)}.
            </Text>
          ) : (
            <div className="mg-chart-grid">
              <ChartCard
                title="Operations"
                caption="Per second, by type"
                times={series.times}
                series={cards.operations}
                yUnit="perSecond"
                syncKey={syncKey}
                emptyText="No samples in this range."
              />
              <ChartCard
                title="Connections"
                caption="Open and available"
                times={series.times}
                series={cards.connections}
                yUnit="count"
                syncKey={syncKey}
                emptyText="No samples in this range."
              />
              <ChartCard
                title="Network"
                caption="Bytes per second"
                times={series.times}
                series={cards.network}
                yUnit="bytesPerSecond"
                syncKey={syncKey}
                emptyText="No samples in this range."
              />
              <ChartCard
                title="Memory"
                caption="Megabytes"
                times={series.times}
                series={cards.memory}
                yUnit="megabytes"
                syncKey={syncKey}
                emptyText="No samples in this range."
              />
              <ChartCard
                title="Queued operations"
                caption="Waiting for the lock"
                times={series.times}
                series={cards.queues}
                yUnit="count"
                syncKey={syncKey}
                emptyText="This server does not report the global lock."
              />
              {hasReplication ? (
                <ChartCard
                  title="Replication lag"
                  caption="Seconds behind the primary"
                  times={series.times}
                  series={cards.replicationLag}
                  yUnit="seconds"
                  syncKey={syncKey}
                  emptyText="No secondary has reported a lag yet."
                />
              ) : null}
            </div>
          )}
        </Stack>
      </div>
    </Stack>
  );
}
