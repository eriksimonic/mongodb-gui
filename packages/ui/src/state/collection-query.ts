import { collectionAccess } from '@mongo-gui/core';

/**
 * The statement that lists the documents of a collection. A name that `db.<name>` does not reach
 * goes through `db.getCollection`, with the name single-quoted and escaped.
 */
export function collectionQueryStatement(collection: string): string {
  return `${collectionAccess(collection)}.find({})`;
}
