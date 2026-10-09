import { seriesColor } from './palette';
import type { SeriesLine } from './series';
import type { ChartSeries } from './chart-types';

/** Gives each line a colour by its position in the card. Callers keep the order stable. */
export function chartSeries(lines: readonly SeriesLine[]): ChartSeries[] {
  return lines.map((line, index) => ({
    key: line.key,
    label: line.label,
    unit: line.unit,
    color: seriesColor(index),
    values: line.values,
  }));
}

/**
 * The values a stacked chart draws: each series holds its own value plus the ones below it. A gap
 * in one series is a gap in its own line, and it counts as zero in the stack above it.
 */
export function stackedValues(series: readonly ChartSeries[]): (number | null)[][] {
  const length = series[0]?.values.length ?? 0;
  const running = new Array<number>(length).fill(0);
  return series.map((item) =>
    item.values.map((value, index) => {
      running[index] = (running[index] ?? 0) + (value ?? 0);
      return value === null ? null : (running[index] ?? 0);
    }),
  );
}
