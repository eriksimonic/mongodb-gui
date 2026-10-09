import { AppErrorException, type RpcEvent } from '@mongo-gui/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockMonitor } from './mock-monitor';

const CONNECTION = '3f2b8c1e-5d4a-4b7e-9c1f-2a6d8e0b7f10';
const ALL_OPERATIONS = { includeIdle: true, includeSystem: true };

describe('createMockMonitor', () => {
  let events: RpcEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    events = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function build(replication = false) {
    return createMockMonitor({
      emit: (event) => {
        events.push(event);
      },
      hasReplication: () => replication,
    });
  }

  it('starts with the default interval and a backfilled history', () => {
    const monitor = build();
    const config = monitor.start(CONNECTION);
    expect(config).toEqual({ intervalMs: 2000, retentionMs: 3_600_000 });
    expect(monitor.samples(CONNECTION).length).toBeGreaterThan(100);
  });

  it('emits one sample per interval', () => {
    const monitor = build();
    monitor.start(CONNECTION, 1000);
    vi.advanceTimersByTime(3000);
    const samples = events.filter((event) => event.type === 'monitor:sample');
    expect(samples).toHaveLength(3);
  });

  it('adds replication only when the connection has it', () => {
    const plain = build(false);
    const replicated = build(true);
    plain.start(CONNECTION);
    replicated.start(`${CONNECTION}`);
    expect(plain.samples(CONNECTION).at(-1)?.replication).toBeUndefined();
    expect(replicated.samples(CONNECTION).at(-1)?.replication?.members).toHaveLength(3);
  });

  it('applies a new interval to the running sampler', () => {
    const monitor = build();
    monitor.start(CONNECTION, 1000);
    expect(monitor.setInterval(CONNECTION, 5000)).toMatchObject({ intervalMs: 5000 });
    vi.advanceTimersByTime(4000);
    expect(events.filter((event) => event.type === 'monitor:sample')).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(events.filter((event) => event.type === 'monitor:sample')).toHaveLength(1);
  });

  it('stops emitting after stop and clears the history', () => {
    const monitor = build();
    monitor.start(CONNECTION, 1000);
    monitor.stop(CONNECTION);
    vi.advanceTimersByTime(5000);
    expect(events).toHaveLength(0);
    expect(monitor.samples(CONNECTION)).toEqual([]);
  });

  it('lists the active operations and hides idle and system rows by default', () => {
    const monitor = build();
    const visible = monitor.operations(CONNECTION, { includeIdle: false, includeSystem: false });
    expect(visible.map((item) => item.opid)).toEqual([1041, 1052, 1077]);
    expect(monitor.operations(CONNECTION, ALL_OPERATIONS)).toHaveLength(5);
  });

  it('runs the long aggregation for more than three minutes', () => {
    const monitor = build();
    const long = monitor
      .operations(CONNECTION, { includeIdle: false, includeSystem: false })
      .find((item) => item.opid === 1077);
    expect(long?.secsRunning).toBeGreaterThanOrEqual(214);
  });

  it('removes a killed operation from later listings', () => {
    const monitor = build();
    monitor.killOperation(CONNECTION, 1077);
    const opids = monitor
      .operations(CONNECTION, { includeIdle: false, includeSystem: false })
      .map((item) => item.opid);
    expect(opids).not.toContain(1077);
  });

  it('reports an unknown opid as an AppError', () => {
    const monitor = build();
    expect(() => monitor.killOperation(CONNECTION, 999_999)).toThrow(AppErrorException);
  });
});
