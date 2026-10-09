import 'uplot/dist/uPlot.min.css';
import uPlot from 'uplot';
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { CHART_HEIGHT_PX, type ChartSeries } from './chart-types';
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
  readonly height?: number;
}

const AXIS_FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
const X_AXIS_HEIGHT_PX = 26;
const Y_AXIS_WIDTH_PX = 56;
const X_TICK_SPACE_PX = 84;
const Y_TICK_SPACE_PX = 40;
const TOOLTIP_OFFSET_PX = 12;
const HEADROOM = 1.1;

interface BuildInput {
  readonly width: number;
  readonly height: number;
  readonly series: readonly ChartSeries[];
  readonly yUnit: MetricUnit;
  readonly syncKey: string;
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

/** Writes one readout per series at the hovered moment. Text goes in with textContent only. */
function renderTooltip(plot: uPlot, element: HTMLDivElement, series: readonly ChartSeries[]): void {
  const index = plot.cursor.idx;
  const xs = plot.data[0];
  const time = index === null || index === undefined ? undefined : xs?.[index];
  if (index === null || index === undefined || time === undefined || time === null) {
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
  const flipLeft = left > plot.over.clientWidth / 2;
  const x = flipLeft ? left - element.offsetWidth - TOOLTIP_OFFSET_PX : left + TOOLTIP_OFFSET_PX;
  element.style.transform = `translate(${Math.max(0, x)}px, ${Math.max(0, top)}px)`;
}

function buildOptions({ width, height, series, yUnit, syncKey }: BuildInput): uPlot.Options {
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
      x: { time: true },
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
        width: 2,
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
 * series set or the unit changes, and updated in place when only the data changes.
 */
export function UPlotChart({
  label,
  times,
  series,
  yUnit,
  syncKey,
  height = CHART_HEIGHT_PX,
}: UPlotChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | undefined>(undefined);
  const width = useElementWidth(hostRef);
  const data = useMemo(
    () => [times.slice(), ...series.map((item) => item.values.slice())] as uPlot.AlignedData,
    [times, series],
  );
  const shape = series.map((item) => `${item.key}|${item.label}|${item.color}`).join(';');
  const latest = useRef({ series, data });

  useEffect(() => {
    latest.current = { series, data };
  }, [series, data]);

  useEffect(() => {
    const host = hostRef.current;
    const current = latest.current;
    if (host === null || width === 0 || current.series.length === 0) {
      return undefined;
    }
    const plot = new uPlot(
      buildOptions({ width, height, series: current.series, yUnit, syncKey }),
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
  }, [width, height, shape, yUnit, syncKey]);

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
