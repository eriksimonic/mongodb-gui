import 'uplot/dist/uPlot.min.css';
import uPlot from 'uplot';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CHART_HEIGHT_PX, type ChartSeries, type ChartWindow } from './chart-types';
import { formatAxisValue, formatClock, formatValue, type MetricUnit } from './format';
import { CHART_INK } from './palette';
import './monitor.css';

export interface UPlotChartProps {
  readonly label: string;
  /** Epoch seconds, shared by every series. */
  readonly times: readonly number[];
  readonly series: readonly ChartSeries[];
  /** Unit of the value axis. Every series in one chart shares it. */
  readonly yUnit: MetricUnit;
  /** Charts with the same key share a cursor, so hovering one marks the same moment on all. */
  readonly syncKey: string;
  /** The window the x axis shows. Without it the axis follows the data. */
  readonly window?: ChartWindow | undefined;
  readonly height?: number;
}

const AXIS_FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
const X_AXIS_HEIGHT_PX = 26;
const Y_AXIS_WIDTH_PX = 56;
const X_TICK_SPACE_PX = 84;
const Y_TICK_SPACE_PX = 40;
const TOOLTIP_OFFSET_PX = 12;
const HEADROOM = 1.1;
const REFERENCE_DASH = [4, 3];

interface BuildInput {
  readonly width: number;
  readonly height: number;
  readonly series: readonly ChartSeries[];
  readonly yUnit: MetricUnit;
  readonly syncKey: string;
  readonly window: ChartWindow | undefined;
}

/** Spreads a value only when it is defined, for uPlot options that reject explicit undefined. */
function ifDefined<T extends object>(value: boolean, build: () => T): T | Record<string, never> {
  return value ? build() : {};
}

/** Writes an element's width to state and keeps it current. Zero until the element is laid out. */
function useElementWidth(ref: RefObject<HTMLDivElement | null>): number {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) {
      return undefined;
    }
    setWidth(Math.floor(element.getBoundingClientRect().width));
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      setWidth(Math.floor(entries[0]?.contentRect.width ?? 0));
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [ref]);
  return width;
}

/** Keeps a value inside [low, high]. When the range is inverted, the low bound wins. */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}

/** Label positions every tick step, from the first multiple at or after the scale minimum. */
function tickSplits(min: number, max: number, step: number): number[] {
  const first = Math.ceil(min / step) * step;
  const splits: number[] = [];
  for (let tick = first; tick <= max; tick += step) {
    splits.push(tick);
  }
  return splits;
}

/**
 * Writes one readout per series at the hovered moment. It shows only in the chart under the
 * pointer, so synced charts keep the crosshair without a tooltip each. Text goes in with textContent.
 */
function renderTooltip(plot: uPlot, element: HTMLDivElement, series: readonly ChartSeries[]): void {
  const index = plot.cursor.idx;
  const time = index === null || index === undefined ? undefined : plot.data[0]?.[index];
  const hovered = plot.over.matches(':hover');
  if (!hovered || index === null || index === undefined || time === undefined || time === null) {
    element.hidden = true;
    return;
  }
  const heading = document.createElement('div');
  heading.className = 'mg-chart-tooltip-time';
  heading.textContent = formatClock(time * 1000);

  const rows = series.map((item, position) => {
    const value = plot.data[position + 1]?.[index];
    const row = document.createElement('div');
    row.className = 'mg-chart-tooltip-row';
    const key = document.createElement('span');
    key.className = 'mg-chart-tooltip-key';
    key.style.background = item.color;
    const name = document.createElement('span');
    name.className = 'mg-chart-tooltip-label';
    name.textContent = item.label;
    const amount = document.createElement('strong');
    amount.className = 'mg-chart-tooltip-value';
    amount.textContent = typeof value === 'number' ? formatValue(value, item.unit) : 'No sample';
    row.append(key, name, amount);
    return row;
  });

  element.replaceChildren(heading, ...rows);
  element.hidden = false;
  const left = plot.cursor.left ?? 0;
  const top = plot.cursor.top ?? 0;
  const overWidth = plot.over.clientWidth;
  const overHeight = plot.over.clientHeight;
  const preferredX =
    left > overWidth / 2
      ? left - element.offsetWidth - TOOLTIP_OFFSET_PX
      : left + TOOLTIP_OFFSET_PX;
  const x = clamp(preferredX, 0, overWidth - element.offsetWidth);
  const y = clamp(top + TOOLTIP_OFFSET_PX, 0, overHeight - element.offsetHeight);
  element.style.transform = `translate(${x}px, ${y}px)`;
}

function buildOptions({
  width,
  height,
  series,
  yUnit,
  syncKey,
  window,
}: BuildInput): uPlot.Options {
  let tooltip: HTMLDivElement | undefined;
  return {
    width,
    height,
    legend: { show: false },
    cursor: {
      x: true,
      y: false,
      drag: { x: false, y: false, setScale: false },
      sync: { key: syncKey, setSeries: false },
      points: { size: 8, width: 2 },
    },
    scales: {
      x: {
        time: true,
        // The window ends at the newest point, so a short history leaves blank space on the left.
        range: (_plot, _min, max) =>
          window === undefined ? [_min, max] : [max - window.windowSeconds, max],
      },
      y: {
        range: (_plot, min, max) => [Math.min(0, min), max > 0 ? max * HEADROOM : 1],
      },
    },
    axes: [
      {
        stroke: CHART_INK.muted,
        font: AXIS_FONT,
        size: X_AXIS_HEIGHT_PX,
        space: X_TICK_SPACE_PX,
        grid: { show: false },
        ticks: { show: false },
        border: { show: true, stroke: CHART_INK.baseline, width: 1 },
        ...ifDefined(window !== undefined, () => ({
          splits: (_plot: uPlot, _axis: number, min: number, max: number) =>
            tickSplits(min, max, window?.tickSeconds ?? 0),
        })),
        values: (_plot, values) => values.map((value) => formatClock(value * 1000)),
      },
      {
        stroke: CHART_INK.muted,
        font: AXIS_FONT,
        size: Y_AXIS_WIDTH_PX,
        space: Y_TICK_SPACE_PX,
        grid: { show: true, stroke: CHART_INK.gridline, width: 1 },
        ticks: { show: false },
        border: { show: false },
        values: (_plot, values) => values.map((value) => formatAxisValue(value, yUnit)),
      },
    ],
    series: [
      {},
      ...series.map((item) => ({
        label: item.label,
        stroke: item.color,
        width: item.dashed === true ? 1 : 2,
        ...ifDefined(item.dashed === true, () => ({ dash: REFERENCE_DASH })),
        points: { show: false },
        spanGaps: false,
      })),
    ],
    hooks: {
      init: [
        (plot) => {
          tooltip = document.createElement('div');
          tooltip.className = 'mg-chart-tooltip';
          tooltip.hidden = true;
          plot.over.appendChild(tooltip);
        },
      ],
      setCursor: [
        (plot) => {
          if (tooltip !== undefined) {
            renderTooltip(plot, tooltip, series);
          }
        },
      ],
    },
  };
}

/**
 * A uPlot line chart in a box that fills its parent. The plot is rebuilt when the width, the
 * series set, the unit or the window changes, and updated in place when only the data changes.
 */
export function UPlotChart({
  label,
  times,
  series,
  yUnit,
  syncKey,
  window,
  height = CHART_HEIGHT_PX,
}: UPlotChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | undefined>(undefined);
  const width = useElementWidth(hostRef);
  const data = useMemo(
    () => [times.slice(), ...series.map((item) => item.values.slice())] as uPlot.AlignedData,
    [times, series],
  );
  const shape = series
    .map((item) => `${item.key}|${item.label}|${item.color}|${item.dashed === true}`)
    .join(';');
  const windowKey = window === undefined ? 'none' : `${window.windowSeconds}/${window.tickSeconds}`;
  const latest = useRef({ series, data, window });

  useEffect(() => {
    latest.current = { series, data, window };
  }, [series, data, window]);

  useEffect(() => {
    const host = hostRef.current;
    const current = latest.current;
    if (host === null || width === 0 || current.series.length === 0) {
      return undefined;
    }
    const plot = new uPlot(
      buildOptions({
        width,
        height,
        series: current.series,
        yUnit,
        syncKey,
        window: current.window,
      }),
      current.data,
      host,
    );
    plotRef.current = plot;
    return () => {
      plot.destroy();
      if (plotRef.current === plot) {
        plotRef.current = undefined;
      }
    };
  }, [width, height, shape, yUnit, syncKey, windowKey]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return (
    <div
      ref={hostRef}
      role="img"
      aria-label={label}
      className="mg-chart"
      style={{ height }}
      data-testid="chart-container"
    />
  );
}
