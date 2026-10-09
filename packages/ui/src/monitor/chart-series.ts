import type { PanelSpec } from '@mongo-gui/core';
import { seriesColor, type ChartScheme } from './palette';
import { MEMBER_KEY_SEPARATOR, type SeriesLine } from './series';
import type { ChartSeries } from './chart-types';

/**
 * Gives each line the colour of its series in the catalogue entry, so a series keeps its colour
 * when another series is absent. Replica lag lines take the colour of the lag series they belong to.
 */
export function chartSeries(
  lines: readonly SeriesLine[],
  panel: PanelSpec,
  scheme: ChartScheme,
): ChartSeries[] {
  return lines.map((line) => ({
    key: line.key,
    label: line.label,
    unit: line.unit,
    color: seriesColor(catalogueIndex(line.key, panel), scheme),
    values: line.values,
  }));
}

function catalogueIndex(key: string, panel: PanelSpec): number {
  const index = panel.series.findIndex(
    (spec) => key === spec.id || key.startsWith(`${spec.id}${MEMBER_KEY_SEPARATOR}`),
  );
  return Math.max(0, index);
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
