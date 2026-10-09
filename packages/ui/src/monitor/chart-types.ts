import type { SeriesUnit } from '@mongo-gui/core';

/** One plotted line. `values` holds null where the server reported nothing or a gap starts. */
export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly unit: SeriesUnit;
  readonly values: readonly (number | null)[];
}

/** How a chart draws its series. Stacked areas add each series to the ones before it. */
export type ChartMode = 'lines' | 'area' | 'stacked';

/** The time window a chart shows, and how far apart its x-axis labels sit. */
export interface ChartWindow {
  readonly windowSeconds: number;
  readonly tickSeconds: number;
}

/** Plot height including the axes, so the x-axis labels always fit inside the card. */
export const CHART_HEIGHT_PX = 176;
/** A chart panel 2 rows tall. Two plot heights and the gap between them. */
export const TALL_CHART_HEIGHT_PX = CHART_HEIGHT_PX * 2 + 24;
