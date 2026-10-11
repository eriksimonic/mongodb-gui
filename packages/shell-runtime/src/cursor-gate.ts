import { calculateObjectSize, type Document } from 'bson';

// A cursor batch stops after about this many bytes of BSON. mongosh reads a batch by calling the
// driver cursor's tryNext once per document, and a document it has taken is gone from the cursor.
// Returning null before taking one leaves it on the cursor, and mongosh then reports that the
// cursor has more, so the next "it" serves it. Without this a batch of huge documents sits whole
// in the shell heap while it is serialised.
export const BATCH_BSON_BUDGET = 4 * 1024 * 1024;

const INSTALLED = Symbol.for('mongo-gui.cursorGate');

interface Batch {
  readonly limit: number;
  count: number;
  bytes: number;
}

// The gate is armed only while mongosh reads one batch, so user code that loops over a cursor
// never sees a cut. When it is not armed, or the driver changes, the batch is simply not cut.
let current: Batch | null = null;

type TryNext = (this: unknown) => Promise<unknown>;

// Wraps tryNext on the driver cursor prototype, once per process. probeCursor is a driver cursor
// that is never run.
export function installCursorGate(probeCursor: object): void {
  let owner: object | null = probeCursor;
  while (owner !== null && !Object.hasOwn(owner, 'tryNext')) {
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  if (owner === null || Object.hasOwn(owner, INSTALLED)) {
    return;
  }
  const original = Reflect.get(owner, 'tryNext') as TryNext;
  const gated: TryNext = async function (this: unknown) {
    const batch = current;
    if (batch === null) {
      return original.call(this);
    }
    if (batch.count > 0 && batch.bytes >= BATCH_BSON_BUDGET) {
      current = null;
      return null;
    }
    const doc = await original.call(this);
    batch.count += 1;
    if (doc === null || batch.count >= batch.limit) {
      if (current === batch) {
        current = null;
      }
    } else {
      batch.bytes += sizeOf(doc);
    }
    return doc;
  };
  Object.defineProperty(owner, 'tryNext', { value: gated, writable: true, configurable: true });
  Object.defineProperty(owner, INSTALLED, { value: true });
}

// Starts a window for a batch of at most limit documents. The first document always passes.
export function armGate(limit: number): void {
  current = { limit, count: 0, bytes: 0 };
}

export function disarmGate(): void {
  current = null;
}

function sizeOf(doc: unknown): number {
  try {
    return calculateObjectSize(doc as Document);
  } catch {
    return 0;
  }
}
