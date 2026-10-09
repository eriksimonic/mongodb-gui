import type { MetricUnit } from './format';

/** One plotted line. `values` holds null where the server reported nothing. */
export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly unit: MetricUnit;
  readonly values: readonly (number | null)[];
}

/** Plot height including the axes, so the x-axis labels always fit inside the card. */
export const CHART_HEIGHT_PX = 176;
