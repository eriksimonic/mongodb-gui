import { Group, Paper, Stack, Text } from '@mantine/core';
import { CHART_HEIGHT_PX, type ChartSeries } from './chart-types';
import { formatValue, type MetricUnit } from './format';
import { UPlotChart } from './UPlotChart';

export interface ChartCardProps {
  readonly title: string;
  readonly caption: string;
  readonly times: readonly number[];
  readonly series: readonly ChartSeries[];
  readonly yUnit: MetricUnit;
  readonly syncKey: string;
  readonly emptyText: string;
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

/**
 * A chart with its title, a row of legend chips that also show each line's latest value, and the
 * plot. Values stay readable without hovering, so the colour is never the only identity cue.
 */
export function ChartCard({
  title,
  caption,
  times,
  series,
  yUnit,
  syncKey,
  emptyText,
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
        {hasData ? (
          <Group gap="sm" wrap="wrap">
            {series.map((item) => {
              const value = latestValue(item.values);
              return (
                <span className="mg-chip" key={item.key}>
                  {series.length > 1 ? (
                    <span
                      className="mg-chip-key"
                      aria-hidden="true"
                      style={{ background: item.color }}
                    />
                  ) : null}
                  <span>{item.label}</span>
                  <span className="mg-chip-value">
                    {value === undefined ? 'No sample' : formatValue(value, item.unit)}
                  </span>
                </span>
              );
            })}
          </Group>
        ) : null}
        {hasData ? (
          <UPlotChart
            label={`${title}, ${caption}`}
            times={times}
            series={series}
            yUnit={yUnit}
            syncKey={syncKey}
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
