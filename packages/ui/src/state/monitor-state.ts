import {
  DEFAULT_MONITOR_RETENTION_MS,
  type AppError,
  type MonitorConfig,
  type MonitorSample,
} from '@mongo-gui/core';
import { mergeSamples } from '../monitor/series';

/** What the store keeps per connection for the monitor. Samples are bounded by retention. */
export interface MonitorView {
  /** Set while the server runs a sampler for this connection. */
  readonly config: MonitorConfig | undefined;
  readonly samples: readonly MonitorSample[];
  /** The last sampler error. A new sample clears it. */
  readonly error: AppError | undefined;
}

export const EMPTY_MONITOR_VIEW: MonitorView = {
  config: undefined,
  samples: [],
  error: undefined,
};

function retentionOf(view: MonitorView): number {
  return view.config?.retentionMs ?? DEFAULT_MONITOR_RETENTION_MS;
}

export function applySample(view: MonitorView, sample: MonitorSample): MonitorView {
  return {
    ...view,
    samples: mergeSamples(view.samples, [sample], retentionOf(view)),
    error: undefined,
  };
}

export function applyError(view: MonitorView, error: AppError): MonitorView {
  return { ...view, error };
}

/** Records a started sampler and merges the history it already holds. */
export function applyStarted(
  view: MonitorView,
  config: MonitorConfig,
  history: readonly MonitorSample[],
): MonitorView {
  return {
    config,
    samples: mergeSamples(view.samples, history, config.retentionMs),
    error: undefined,
  };
}

export function applyIntervalChange(view: MonitorView, config: MonitorConfig): MonitorView {
  return { ...view, config };
}

/** The sampler is gone. Samples stay so the dashboard can show what it had. */
export function applyStopped(view: MonitorView): MonitorView {
  return { ...view, config: undefined, error: undefined };
}
