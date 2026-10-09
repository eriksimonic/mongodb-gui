import { localConnectionId } from '../api/mock-fixtures';
import { objectIdHex } from '../api/mock-catalog';
import type { UiApi } from '../api/ui-api';

/** A messy collection for stories and tests: optional fields, mixed types, nested documents. */
export const MESSY_DATABASE = 'analytics';
export const MESSY_COLLECTION = 'raw_events';
export const MESSY_COUNT = 150;

const EVENTS = ['click', 'view', 'purchase', 'error'] as const;
const DAY_MS = 86_400_000;
const EPOCH_2026 = Date.parse('2026-01-01T00:00:00.000Z');

/**
 * Documents with the shapes a real collection grows into. `note` appears in one document in
 * seven, `duration` changes type, `user.plan` is sometimes null, and `items` holds documents.
 */
export function messyDocuments(count: number = MESSY_COUNT): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, index) => {
    const document: Record<string, unknown> = {
      _id: { $oid: objectIdHex(index + 1) },
      event: EVENTS[index % EVENTS.length],
      at: { $date: new Date(EPOCH_2026 + index * DAY_MS).toISOString() },
      duration: durationOf(index),
      user: {
        id: `U-${index % 40}`,
        plan: index % 6 === 0 ? null : 'pro',
      },
      tags: index % 3 === 0 ? [] : ['web', index % 2 === 0 ? 'mobile' : 'desktop'],
      items: Array.from({ length: index % 4 }, (_item, position) => ({
        sku: `SKU-${(index + position) % 9}`,
        qty: position + 1,
      })),
    };
    if (index % 7 === 0) {
      document.note = 'retry';
    }
    return document;
  });
}

/** Int32 for most documents, a string for some, and a double for the rest. */
function durationOf(index: number): unknown {
  if (index % 5 === 0) {
    return `${index}ms`;
  }
  if (index % 3 === 0) {
    return { $numberDouble: `${index}.5` };
  }
  return { $numberInt: String(index % 50) };
}

/** Creates the messy collection on the local connection and inserts its documents. */
export async function seedMessyCollection(api: UiApi, count: number = MESSY_COUNT): Promise<void> {
  await api.rpc.management.createCollection({
    connectionId: localConnectionId,
    database: MESSY_DATABASE,
    name: MESSY_COLLECTION,
  });
  for (const document of messyDocuments(count)) {
    await api.rpc.management.insertDocument({
      connectionId: localConnectionId,
      database: MESSY_DATABASE,
      collection: MESSY_COLLECTION,
      documentEjson: JSON.stringify(document),
    });
  }
}
