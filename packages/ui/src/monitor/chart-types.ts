import type { MetricUnit } from './format';

/** One plotted line. `values` holds null where the server reported nothing or a gap starts. */
export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly unit: MetricUnit;
  readonly values: readonly (number | null)[];
  /** Reference lines are drawn dashed, so they read as a limit and not as a measurement. */
  readonly dashed?: boolean;
}

/** The time window a chart shows, and how far apart its x-axis labels sit. */
export interface ChartWindow {
  readonly windowSeconds: number;
  readonly tickSeconds: number;
}

/** Plot height including the axes, so the x-axis labels always fit inside the card. */
export const CHART_HEIGHT_PX = 176;
