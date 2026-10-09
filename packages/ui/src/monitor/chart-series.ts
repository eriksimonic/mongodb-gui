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
    ...(line.reference === true ? { dashed: true } : {}),
  }));
}
