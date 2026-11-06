import { MongoServerError, type MongoClient } from 'mongodb';

const NAMESPACE_NOT_FOUND = 'NamespaceNotFound';

export interface CollectionRef {
  readonly db: string;
  readonly collection: string;
}

// Drops the collection and does nothing when it does not exist.
export async function dropCollectionIfExists(
  client: MongoClient,
  ref: CollectionRef,
): Promise<void> {
  try {
    await client.db(ref.db).collection(ref.collection).drop();
  } catch (error) {
    if (error instanceof MongoServerError && error.codeName === NAMESPACE_NOT_FOUND) {
      return;
    }
    throw error;
  }
}
