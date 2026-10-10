import { describe, expect, it } from 'vitest';
import { parseToolLine } from '@mongo-gui/core';
import { createProgressTracker, type ProgressTracker } from './progress-tracker';

const RUNNING = { done: false, cancelled: false };

function clock(start = 1000) {
  let time = start;
  return {
    now: () => time,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

function feed(tracker: ProgressTracker, ...lines: string[]): void {
  for (const line of lines) tracker.line(parseToolLine(line), line);
}

describe('createProgressTracker for a dump', () => {
  it('starts in preparing with the totals and no fraction', () => {
    const tracker = createProgressTracker('dump', { documents: 100, namespaces: 2 }, () => 0);
    expect(tracker.snapshot(RUNNING)).toEqual({
      phase: 'preparing',
      documents: 0,
      totalDocuments: 100,
      bytes: 0,
      active: [],
      finishedNamespaces: 0,
      totalNamespaces: 2,
      failedDocuments: 0,
      lines: [],
      warnings: [],
      elapsedMs: 0,
      done: false,
      cancelled: false,
    });
  });

  it('adds finished counts and current bars, capped below 1 while running', () => {
    const time = clock();
    const tracker = createProgressTracker('dump', { documents: 100, namespaces: 2 }, time.now);
    tracker.phase('running');
    feed(
      tracker,
      '2026-10-10T18:42:00.000+0200\twriting `shop.orders` to archive on stdout',
      '[############............]  shop.orders  40/100  (40.0%)',
    );
    time.advance(500);
    let progress = tracker.snapshot(RUNNING);
    expect(progress.phase).toBe('running');
    expect(progress.documents).toBe(40);
    expect(progress.fraction).toBeCloseTo(0.4);
    expect(progress.active).toEqual([{ namespace: 'shop.orders', documents: 40, total: 100 }]);
    expect(progress.elapsedMs).toBe(500);

    feed(
      tracker,
      'done dumping `shop.orders` (100 documents)',
      'done dumping `shop.users` (20 documents)',
    );
    progress = tracker.snapshot(RUNNING);
    expect(progress.documents).toBe(120);
    expect(progress.fraction).toBe(0.99);
    expect(progress.active).toEqual([]);
    expect(progress.finishedNamespaces).toBe(2);
    expect(tracker.finished()).toEqual(
      new Map([
        ['shop.orders', 100],
        ['shop.users', 20],
      ]),
    );
    expect(tracker.snapshot({ done: true, cancelled: false }).fraction).toBe(1);
  });

  it('reports only the lines and warnings since the previous snapshot', () => {
    const tracker = createProgressTracker('dump', {}, () => 0);
    feed(tracker, 'first', 'WARNING: one');
    expect(tracker.snapshot(RUNNING)).toMatchObject({
      lines: ['first', 'WARNING: one'],
      warnings: ['WARNING: one'],
    });
    feed(tracker, 'second');
    expect(tracker.snapshot(RUNNING)).toMatchObject({ lines: ['second'], warnings: [] });
    expect(tracker.warnings()).toEqual(['WARNING: one']);
  });

  it('keeps the newest 100 lines, 20 warnings and 32 active namespaces', () => {
    const tracker = createProgressTracker('dump', {}, () => 0);
    for (let index = 0; index < 150; index += 1) feed(tracker, `line ${index}`);
    for (let index = 0; index < 30; index += 1) feed(tracker, `WARNING: w${index}`);
    for (let index = 0; index < 40; index += 1) feed(tracker, `writing \`db.c${index}\` to x`);
    const progress = tracker.snapshot(RUNNING);
    expect(progress.lines).toHaveLength(100);
    expect(progress.lines.at(-1)).toBe('writing `db.c39` to x');
    expect(progress.warnings).toHaveLength(20);
    expect(progress.warnings.at(-1)).toBe('WARNING: w29');
    expect(progress.active).toHaveLength(32);
  });

  it('names the current database and clears the active list on a switch', () => {
    const tracker = createProgressTracker('dump', {}, () => 0);
    tracker.database('shop', 1, 2);
    feed(tracker, 'writing `shop.orders` to x');
    tracker.database('crm', 2, 2);
    expect(tracker.snapshot(RUNNING)).toMatchObject({
      currentDatabase: 'crm',
      databaseIndex: 2,
      databaseCount: 2,
      active: [],
    });
  });

  it('uses a byte total for the hashing phase', () => {
    const tracker = createProgressTracker('dump', { documents: 10 }, () => 0);
    tracker.phase('running');
    tracker.bytes(999);
    tracker.phase('hashing', 200);
    tracker.bytes(50);
    expect(tracker.snapshot(RUNNING)).toMatchObject({
      phase: 'hashing',
      bytes: 50,
      totalBytes: 200,
      fraction: 0.25,
    });
    tracker.phase('writing-sidecar');
    const progress = tracker.snapshot(RUNNING);
    expect(progress.totalBytes).toBeUndefined();
    expect(progress.fraction).toBeUndefined();
  });

  it('gives no fraction for a failed or cancelled end', () => {
    const tracker = createProgressTracker('dump', { documents: 10 }, () => 0);
    expect(tracker.snapshot({ done: true, cancelled: true }).fraction).toBeUndefined();
    expect(tracker.snapshot({ done: true, cancelled: true }).phase).toBe('finished');
  });
});

describe('createProgressTracker for a restore', () => {
  it('uses bytes over the archive size', () => {
    const tracker = createProgressTracker('restore', { documents: 1000 }, () => 0);
    tracker.phase('running', 400);
    tracker.bytes(100);
    expect(tracker.snapshot(RUNNING).fraction).toBe(0.25);
  });

  it('uses documents over the sidecar total and counts failures', () => {
    const tracker = createProgressTracker('restore', { documents: 200 }, () => 0);
    tracker.phase('running');
    feed(
      tracker,
      'restoring `shop.orders` from /dump/shop/orders.bson',
      'finished restoring `shop.orders` (98 documents, 2 failures)',
    );
    const progress = tracker.snapshot(RUNNING);
    expect(progress.documents).toBe(98);
    expect(progress.failedDocuments).toBe(2);
    expect(progress.fraction).toBeCloseTo(0.49);
    expect(tracker.restoring()).toEqual(['shop.orders']);
  });

  it('takes the summary line as the final count', () => {
    const tracker = createProgressTracker('restore', {}, () => 0);
    feed(tracker, '120 document(s) restored successfully. 3 document(s) failed to restore.');
    expect(tracker.documents()).toBe(120);
    expect(tracker.failed()).toBe(3);
  });

  it('falls back to the byte bars of a folder restore', () => {
    const tracker = createProgressTracker('restore', {}, () => 0);
    tracker.phase('running');
    feed(tracker, '[############............]  shop.orders  1.0KB/2.0KB  (50.0%)');
    expect(tracker.snapshot(RUNNING).fraction).toBeCloseTo(0.5);
    feed(
      tracker,
      'finished restoring `shop.orders` (10 documents, 0 failures)',
      '[........................]  shop.users  0B/2.0KB  (0.0%)',
    );
    expect(tracker.snapshot(RUNNING).fraction).toBeCloseTo(0.5);
  });

  it('has no fraction without any total', () => {
    const tracker = createProgressTracker('restore', {}, () => 0);
    tracker.phase('running');
    feed(tracker, '[........................]  shop.orders  12');
    expect(tracker.snapshot(RUNNING).fraction).toBeUndefined();
  });
});
