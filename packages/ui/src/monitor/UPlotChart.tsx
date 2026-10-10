import 'uplot/dist/uPlot.min.css';
import type { SeriesUnit } from '@mongo-gui/core';
import uPlot from 'uplot';
import { useComputedColorScheme } from '@mantine/core';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CHART_HEIGHT_PX, type ChartMode, type ChartSeries, type ChartWindow } from './chart-types';
import { stackedValues } from './chart-series';
import { formatAxisValue, formatClock, formatValue } from './format';
import { chartPalette, type ChartPalette } from './palette';
import './monitor.css';

export interface UPlotChartProps {
  readonly label: string;
  /** Epoch seconds, shared by every series. */
  readonly times: readonly number[];
  readonly series: readonly ChartSeries[];
  /** Unit of the value axis. Every series in one chart shares it. */
  readonly yUnit: SeriesUnit;
  /** Charts with the same key share a cursor, so hovering one marks the same moment on all. */
  readonly syncKey: string;
  /** The window the x axis shows. Without it the axis follows the data. */
  readonly window?: ChartWindow | undefined;
  readonly mode?: ChartMode;
  readonly height?: number;
}

const AXIS_FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
const X_AXIS_HEIGHT_PX = 26;
const Y_AXIS_WIDTH_PX = 56;
const X_TICK_SPACE_PX = 84;
const Y_TICK_SPACE_PX = 40;
const TOOLTIP_OFFSET_PX = 12;
const HEADROOM = 1.1;
// Area fills take the series colour at this alpha. Two hex digits, appended to a #rrggbb colour.
const AREA_FILL_ALPHA = '33';

const KIBI = 1024;
/** Byte axis steps: 1, 2, 4 ... 512 times each power of 1024, so every step is a whole number of bytes. */
const BYTE_INCREMENTS: readonly number[] = Array.from({ length: 5 }, (_, power) =>
  Array.from({ length: 10 }, (_, step) => KIBI ** power * 2 ** step),
)
  .flat()
  .sort((a, b) => a - b);
/** Count axis steps: 1, 2 and 5 times each power of ten. Every step is an integer. */
const COUNT_INCREMENTS: readonly number[] = Array.from({ length: 10 }, (_, power) =>
  [1, 2, 5].map((mantissa) => mantissa * 10 ** power),
).flat();

/** The axis steps for a unit. Other units let uPlot choose its own. */
function axisIncrements(unit: SeriesUnit): number[] | undefined {
  switch (unit) {
    case 'bytes':
    case 'bytes-per-second':
      return [...BYTE_INCREMENTS];
    case 'count':
      return [...COUNT_INCREMENTS];
    default:
      return undefined;
  }
}

interface BuildInput {
  readonly ink: ChartPalette['ink'];
  readonly width: number;
  readonly height: number;
  readonly series: readonly ChartSeries[];
  /** Returns the series as they are now. The tooltip reads it on each cursor move, after data updates. */
  readonly readSeries: () => readonly ChartSeries[];
  readonly yUnit: SeriesUnit;
  readonly syncKey: string;
  readonly window: ChartWindow | undefined;
  readonly mode: ChartMode;
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
 * The window's tick step, doubled until the labels fit the plot without touching. A narrow card
 * keeps fewer labels, so it shows a wider step than the window asks for.
 */
function fittingStep(plot: uPlot, min: number, max: number, baseStep: number): number {
  if (baseStep <= 0) {
    return baseStep;
  }
  const maxLabels = Math.max(1, Math.floor(plot.over.clientWidth / X_TICK_SPACE_PX));
  let multiple = 1;
  while ((max - min) / (baseStep * multiple) > maxLabels) {
    multiple += 1;
  }
  return baseStep * multiple;
}

/**
 * Writes one readout per series at the hovered moment. It shows only in the chart under the
 * pointer, so synced charts keep the crosshair without a tooltip each. Text goes in with textContent.
 * The readouts read the series values, not the plotted ones, so a stacked area shows each value as it is.
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

  const rows = series.map((item) => {
    const value = item.values[index];
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
  // A tall tooltip in a short plot is cut to the plot area, never drawn past its edges.
  element.style.maxHeight = `${Math.max(0, overHeight - 2 * TOOLTIP_OFFSET_PX)}px`;
  element.style.overflow = 'hidden';
  const preferredX =
    left > overWidth / 2
      ? left - element.offsetWidth - TOOLTIP_OFFSET_PX
      : left + TOOLTIP_OFFSET_PX;
  const x = clamp(preferredX, 0, overWidth - element.offsetWidth);
  const y = clamp(top + TOOLTIP_OFFSET_PX, 0, overHeight - element.offsetHeight);
  element.style.transform = `translate(${x}px, ${y}px)`;
}

function buildOptions({
  ink,
  width,
  height,
  series,
  readSeries,
  yUnit,
  syncKey,
  window,
  mode,
}: BuildInput): uPlot.Options {
  let tooltip: HTMLDivElement | undefined;
  const filled = mode !== 'lines';
  const stacked = mode === 'stacked';
  const increments = axisIncrements(yUnit);
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
        range: (_plot, min, max) =>
          window === undefined ? [min, max] : [max - window.windowSeconds, max],
      },
      y: {
        range: (_plot, min, max) => [Math.min(0, min), max > 0 ? max * HEADROOM : 1],
      },
    },
    axes: [
      {
        stroke: ink.muted,
        font: AXIS_FONT,
        size: X_AXIS_HEIGHT_PX,
        space: X_TICK_SPACE_PX,
        grid: { show: false },
        ticks: { show: false },
        border: { show: true, stroke: ink.baseline, width: 1 },
        ...ifDefined(window !== undefined, () => ({
          splits: (plot: uPlot, _axis: number, min: number, max: number) =>
            tickSplits(min, max, fittingStep(plot, min, max, window?.tickSeconds ?? 0)),
        })),
        values: (_plot, values) => values.map((value) => formatClock(value * 1000)),
      },
      {
        stroke: ink.muted,
        font: AXIS_FONT,
        size: Y_AXIS_WIDTH_PX,
        space: Y_TICK_SPACE_PX,
        grid: { show: true, stroke: ink.gridline, width: 1 },
        ticks: { show: false },
        border: { show: false },
        ...(increments === undefined ? {} : { incrs: increments }),
        values: (_plot, values) => values.map((value) => formatAxisValue(value, yUnit)),
      },
    ],
    series: [
      {},
      ...series.map((item, index) => ({
        label: item.label,
        stroke: item.color,
        width: 2,
        // A stack fills its bottom series to zero. Each higher series fills through its band below.
        ...ifDefined(filled && (!stacked || index === 0), () => ({
          fill: `${item.color}${AREA_FILL_ALPHA}`,
        })),
        points: { show: false },
        spanGaps: false,
      })),
    ],
    ...ifDefined(stacked, () => ({
      // uPlot series 0 is the x axis, so series i of the stack is uPlot series i + 1. The band
      // for series i fills between series i and the series below it.
      bands: series.slice(1).map((item, index) => ({
        series: [index + 2, index + 1] as [number, number],
        fill: `${item.color}${AREA_FILL_ALPHA}`,
      })),
    })),
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
            renderTooltip(plot, tooltip, readSeries());
          }
        },
      ],
    },
  };
}

/** The values uPlot draws: the series as they are, or the running totals for a stacked chart. */
function plottedValues(series: readonly ChartSeries[], mode: ChartMode): (number | null)[][] {
  return mode === 'stacked' ? stackedValues(series) : series.map((item) => [...item.values]);
}

/**
 * A uPlot chart in a box that fills its parent. The plot is rebuilt when the width, the series set,
 * the unit, the mode or the window changes, and updated in place when only the data changes.
 */
export function UPlotChart({
  label,
  times,
  series,
  yUnit,
  syncKey,
  window,
  mode = 'lines',
  height = CHART_HEIGHT_PX,
}: UPlotChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | undefined>(undefined);
  const width = useElementWidth(hostRef);
  // The axis, grid and tooltip ink follow the scheme. A scheme change rebuilds the plot.
  const scheme = useComputedColorScheme('dark');
  const ink = chartPalette(scheme).ink;
  const data = useMemo(
    () => [times.slice(), ...plottedValues(series, mode)] as uPlot.AlignedData,
    [times, series, mode],
  );
  const shape = series.map((item) => `${item.key}|${item.label}|${item.color}`).join(';');
  const windowKey = window === undefined ? 'none' : `${window.windowSeconds}/${window.tickSeconds}`;
  const latest = useRef({ series, data, window, mode });

  useEffect(() => {
    latest.current = { series, data, window, mode };
  }, [series, data, window, mode]);

  useEffect(() => {
    const host = hostRef.current;
    const current = latest.current;
    if (host === null || width === 0 || current.series.length === 0) {
      return undefined;
    }
    const plot = new uPlot(
      buildOptions({
        ink,
        width,
        height,
        series: current.series,
        readSeries: () => latest.current.series,
        yUnit,
        syncKey,
        window: current.window,
        mode: current.mode,
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
  }, [width, height, shape, yUnit, syncKey, windowKey, mode, ink]);

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
