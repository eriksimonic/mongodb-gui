import { seriesColor, type ChartScheme } from './palette';
import type { SeriesLine } from './series';
import type { ChartSeries } from './chart-types';

/**
 * Gives each line a colour by its position in the card, for the scheme on screen. Callers keep the
 * order stable, so a line keeps its colour when the theme changes.
 */
export function chartSeries(lines: readonly SeriesLine[], scheme: ChartScheme): ChartSeries[] {
  return lines.map((line, index) => ({
    key: line.key,
    label: line.label,
    unit: line.unit,
    color: seriesColor(index, scheme),
    values: line.values,
    ...(line.reference === true ? { dashed: true } : {}),
  }));
}
