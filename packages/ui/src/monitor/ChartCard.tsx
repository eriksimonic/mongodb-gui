import { Group, Paper, Stack, Text } from '@mantine/core';
import { CHART_HEIGHT_PX, type ChartSeries, type ChartWindow } from './chart-types';
import { formatValue, type MetricUnit } from './format';
import { UPlotChart } from './UPlotChart';

export interface ChartCardProps {
  readonly title: string;
  readonly caption: string;
  readonly times: readonly number[];
  readonly series: readonly ChartSeries[];
  /** Values shown as chips only. They are not drawn, so they never set the scale. */
  readonly readouts?: readonly ChartSeries[];
  readonly yUnit: MetricUnit;
  readonly syncKey: string;
  readonly emptyText: string;
  readonly window?: ChartWindow | undefined;
}

function latestValue(values: readonly (number | null)[]): number | undefined {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

function Chip({ item, keyed }: { readonly item: ChartSeries; readonly keyed: boolean }) {
  const value = latestValue(item.values);
  return (
    <span className="mg-chip">
      {keyed ? (
        <span
          className="mg-chip-key"
          aria-hidden="true"
          data-dashed={item.dashed === true ? 'true' : undefined}
          style={{
            background: item.dashed === true ? 'transparent' : item.color,
            borderColor: item.color,
          }}
        />
      ) : null}
      <span>{item.label}</span>
      <span className="mg-chip-value">
        {value === undefined ? 'No sample' : formatValue(value, item.unit)}
      </span>
    </span>
  );
}

/**
 * A chart with its title, a legend row of chips that also show each line's latest value, and the
 * plot. Values stay readable without hovering, so the colour is never the only identity cue. The
 * chip row keeps its height even when a card has no data.
 */
export function ChartCard({
  title,
  caption,
  times,
  series,
  readouts = [],
  yUnit,
  syncKey,
  emptyText,
  window,
}: ChartCardProps) {
  const hasData = times.length > 1 && series.length > 0;
  return (
    <Paper withBorder p="sm" radius="sm" data-testid="chart-card">
      <Stack gap={6}>
        <Group justify="space-between" wrap="nowrap" gap="xs">
          <Text size="sm" fw={600}>
            {title}
          </Text>
          <Text size="xs" c="dimmed" ta="right">
            {caption}
          </Text>
        </Group>
        <Group className="mg-chip-row" gap="sm" wrap="wrap">
          {hasData
            ? series.map((item) => <Chip key={item.key} item={item} keyed={series.length > 1} />)
            : null}
          {hasData
            ? readouts.map((item) => <Chip key={item.key} item={item} keyed={false} />)
            : null}
        </Group>
        {hasData ? (
          <UPlotChart
            label={`${title}, ${caption}`}
            times={times}
            series={series}
            yUnit={yUnit}
            syncKey={syncKey}
            window={window}
          />
        ) : (
          <Text
            size="sm"
            c="dimmed"
            style={{ height: CHART_HEIGHT_PX, display: 'flex', alignItems: 'center' }}
          >
            {emptyText}
          </Text>
        )}
      </Stack>
    </Paper>
  );
}
