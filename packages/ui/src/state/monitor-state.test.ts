import type { MonitorConfig, MonitorSample } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import {
  applyError,
  applyIntervalChange,
  applySample,
  applyStarted,
  applyStopped,
  EMPTY_MONITOR_VIEW,
} from './monitor-state';

function sampleAt(second: number): MonitorSample {
  return {
    at: new Date(Date.UTC(2026, 9, 9, 10, 0, second)).toISOString(),
    uptimeSeconds: second,
    opcounters: { insert: 0, query: 0, update: 0, delete: 0, getmore: 0, command: 0 },
    connections: { current: 1, available: 100 },
    network: { bytesInPerSec: 0, bytesOutPerSec: 0, requestsPerSec: 0 },
    memory: { residentMb: 10, virtualMb: 20 },
  };
}

const CONFIG: MonitorConfig = { intervalMs: 2000, retentionMs: 3_600_000 };

describe('monitor view reducers', () => {
  it('records a started sampler with the history it already holds', () => {
    const view = applyStarted(EMPTY_MONITOR_VIEW, CONFIG, [sampleAt(0), sampleAt(2)]);
    expect(view.config).toEqual(CONFIG);
    expect(view.samples).toHaveLength(2);
  });

  it('appends a sample and clears the error', () => {
    const failed = applyError(EMPTY_MONITOR_VIEW, { code: 'INTERNAL', message: 'Boom' });
    const view = applySample(failed, sampleAt(4));
    expect(view.error).toBeUndefined();
    expect(view.samples.map((item) => item.at)).toEqual([sampleAt(4).at]);
  });

  it('keeps samples when the sampler stops, and drops the config', () => {
    const running = applyStarted(EMPTY_MONITOR_VIEW, CONFIG, [sampleAt(0)]);
    const stopped = applyStopped(running);
    expect(stopped.config).toBeUndefined();
    expect(stopped.samples).toHaveLength(1);
  });

  it('replaces the config after an interval change', () => {
    const view = applyIntervalChange(applyStarted(EMPTY_MONITOR_VIEW, CONFIG, []), {
      ...CONFIG,
      intervalMs: 10_000,
    });
    expect(view.config?.intervalMs).toBe(10_000);
  });
});
