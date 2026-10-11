import { afterEach, describe, expect, it } from 'vitest';
import { armGate, BATCH_BSON_BUDGET, disarmGate, installCursorGate } from './cursor-gate';

const BIG = 'z'.repeat(1024 * 1024);

class FakeCursor {
  calls = 0;
  private index = 0;

  constructor(private readonly docs: readonly Record<string, unknown>[]) {}

  async tryNext(): Promise<Record<string, unknown> | null> {
    this.calls += 1;
    return this.docs[this.index++] ?? null;
  }
}

class FakeFindCursor extends FakeCursor {}

// The gate patches the prototype that owns tryNext, so one fake class is patched once per test file.
const probe = new FakeFindCursor([]);
installCursorGate(probe);

function bigDocs(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, i) => ({ i, body: BIG }));
}

async function drain(cursor: FakeCursor, limit: number): Promise<unknown[]> {
  const out: unknown[] = [];
  for (let i = 0; i < limit; i++) {
    const doc = await cursor.tryNext();
    if (doc === null) {
      break;
    }
    out.push(doc);
  }
  return out;
}

afterEach(() => {
  disarmGate();
});

describe('cursor gate', () => {
  it('passes everything through while unarmed', async () => {
    const cursor = new FakeFindCursor(bigDocs(8));
    expect(await drain(cursor, 20)).toHaveLength(8);
  });

  it('stops once the batch holds the budget and leaves the rest on the cursor', async () => {
    const cursor = new FakeFindCursor(bigDocs(10));
    armGate(10);
    const batch = await drain(cursor, 10);
    expect(batch.length).toBeGreaterThanOrEqual(2);
    expect(batch.length).toBeLessThanOrEqual(5);
    expect(batch.length * 1024 * 1024).toBeGreaterThanOrEqual(BATCH_BSON_BUDGET);
    // The stopping call did not reach the cursor, so no document was consumed by it.
    expect(cursor.calls).toBe(batch.length);
    const rest = await drain(cursor, 20);
    expect(batch.length + rest.length).toBe(10);
  });

  it('lets a first document larger than the budget through', async () => {
    const huge = { body: 'q'.repeat(BATCH_BSON_BUDGET + 10) };
    const cursor = new FakeFindCursor([huge, { i: 2 }]);
    armGate(10);
    expect(await drain(cursor, 10)).toEqual([huge]);
    expect(await drain(cursor, 10)).toEqual([{ i: 2 }]);
  });

  it('disarms when the batch limit is reached', async () => {
    const cursor = new FakeFindCursor(bigDocs(10));
    armGate(2);
    expect(await drain(cursor, 2)).toHaveLength(2);
    expect(await drain(cursor, 10)).toHaveLength(8);
  });

  it('disarms when the cursor is exhausted', async () => {
    const cursor = new FakeFindCursor([{ i: 1 }]);
    armGate(10);
    expect(await drain(cursor, 10)).toHaveLength(1);
    const other = new FakeFindCursor(bigDocs(6));
    expect(await drain(other, 10)).toHaveLength(6);
  });

  it('disarmGate ends the window', async () => {
    const cursor = new FakeFindCursor(bigDocs(10));
    armGate(10);
    disarmGate();
    expect(await drain(cursor, 10)).toHaveLength(10);
  });

  it('wraps tryNext once however often it is installed', async () => {
    installCursorGate(probe);
    installCursorGate(new FakeFindCursor([]));
    const cursor = new FakeFindCursor(bigDocs(10));
    armGate(10);
    const batch = await drain(cursor, 10);
    expect(cursor.calls).toBe(batch.length);
  });

  it('never returns a spurious null outside the armed window', async () => {
    const cursor = new FakeFindCursor(bigDocs(12));
    armGate(10);
    await drain(cursor, 10);
    disarmGate();
    const rest = await drain(cursor, 20);
    expect(rest.length).toBeGreaterThan(0);
    const seen = new FakeFindCursor(bigDocs(12));
    expect(await drain(seen, 20)).toHaveLength(12);
  });
});
