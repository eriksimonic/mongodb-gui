import type { LogLine, ServerLog } from '@mongo-gui/core';
import { describe, expect, it } from 'vitest';
import { logWindowOf, mergeLogWindow } from './log-window';

function line(n: number): LogLine {
  return { message: `line ${n}`, raw: `line ${n}` };
}

/** A reply whose newest line is written as line `total`, with `size` lines kept. */
function reply(total: number, size: number): ServerLog {
  return {
    kind: 'global',
    total,
    lines: Array.from({ length: size }, (_, index) => line(total - size + index + 1)),
  };
}

describe('logWindowOf', () => {
  it('numbers the first line from the total and the number of lines kept', () => {
    const window = logWindowOf(reply(100, 10));
    expect(window.firstId).toBe(90);
    expect(window.lines).toHaveLength(10);
  });
});

describe('mergeLogWindow', () => {
  it('appends only the lines written since the last read', () => {
    const first = mergeLogWindow(undefined, reply(100, 10));
    const firstLine = first.lines[0];
    const second = mergeLogWindow(first, reply(103, 13));

    expect(second.lines).toHaveLength(13);
    expect(second.lines.slice(0, 10)).toEqual(first.lines);
    expect(second.lines[0]).toBe(firstLine);
    expect(second.lines[12]?.message).toBe('line 103');
  });

  it('drops the lines the ring buffer has evicted', () => {
    const first = mergeLogWindow(undefined, reply(100, 10));
    const second = mergeLogWindow(first, reply(105, 10));

    expect(second.firstId).toBe(95);
    expect(second.lines[0]?.message).toBe('line 96');
    expect(second.lines[second.lines.length - 1]?.message).toBe('line 105');
  });

  it('keeps the window unchanged when nothing new was written', () => {
    const first = mergeLogWindow(undefined, reply(100, 10));
    const second = mergeLogWindow(first, reply(100, 10));
    expect(second.lines).toHaveLength(10);
    expect(second.lines[9]).toBe(first.lines[9]);
  });

  it('starts again when the server restarted and its total went down', () => {
    const first = mergeLogWindow(undefined, reply(100, 10));
    const second = mergeLogWindow(first, reply(4, 4));
    expect(second.lines).toHaveLength(4);
    expect(second.firstId).toBe(0);
  });

  it('starts again when lines were lost between two reads', () => {
    const first = mergeLogWindow(undefined, reply(100, 10));
    const second = mergeLogWindow(first, reply(500, 10));
    expect(second.lines.map((item) => item.message)).toEqual(
      reply(500, 10).lines.map((item) => item.message),
    );
  });
});
