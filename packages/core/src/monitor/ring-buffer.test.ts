import { describe, expect, it } from 'vitest';
import { createRingBuffer } from './ring-buffer';

interface Tick {
  at: string;
  value: number;
}

function tickAt(second: number, value = second): Tick {
  return { at: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(), value };
}

describe('createRingBuffer', () => {
  it('starts empty', () => {
    const buffer = createRingBuffer<Tick>(60_000);
    expect(buffer.toArray()).toEqual([]);
    expect(buffer.latest()).toBeUndefined();
    expect(buffer.since(tickAt(0).at)).toEqual([]);
  });

  it('returns samples oldest first and reports the latest', () => {
    const buffer = createRingBuffer<Tick>(60_000);
    buffer.push(tickAt(0));
    buffer.push(tickAt(1));
    buffer.push(tickAt(2));

    expect(buffer.toArray().map((tick) => tick.value)).toEqual([0, 1, 2]);
    expect(buffer.latest()?.value).toBe(2);
  });

  it('returns a copy from toArray', () => {
    const buffer = createRingBuffer<Tick>(60_000);
    buffer.push(tickAt(0));
    buffer.toArray().pop();

    expect(buffer.toArray()).toHaveLength(1);
  });

  it('evicts samples older than the retention window relative to the newest sample', () => {
    const buffer = createRingBuffer<Tick>(3000);
    for (let second = 0; second <= 5; second++) {
      buffer.push(tickAt(second));
    }

    // Newest is at 5 s, so the window keeps 2 s through 5 s inclusive.
    expect(buffer.toArray().map((tick) => tick.value)).toEqual([2, 3, 4, 5]);
  });

  it('evicts by the newest timestamp even when the buffer was filled in one burst', () => {
    const buffer = createRingBuffer<Tick>(1000);
    buffer.push(tickAt(0));
    buffer.push(tickAt(10));

    expect(buffer.toArray().map((tick) => tick.value)).toEqual([10]);
  });

  it('returns only samples strictly after the given time', () => {
    const buffer = createRingBuffer<Tick>(60_000);
    for (let second = 0; second < 5; second++) {
      buffer.push(tickAt(second));
    }

    expect(buffer.since(tickAt(2).at).map((tick) => tick.value)).toEqual([3, 4]);
    expect(buffer.since(tickAt(0).at).map((tick) => tick.value)).toEqual([1, 2, 3, 4]);
  });
});
