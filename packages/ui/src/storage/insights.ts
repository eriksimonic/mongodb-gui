import type { StorageCollection } from '@mongo-gui/core';

export type StorageIndex = StorageCollection['indexes'][number];

export type TaggedCollection = StorageCollection & { database: string };

export type TaggedIndex = StorageIndex & { database: string; collection: string };

export type StorageInsights = {
  topCollections: TaggedCollection[];
  topIndexes: TaggedIndex[];
  unusedIndexes: { items: TaggedIndex[]; totalSize: number };
  indexHeavyCollections: TaggedCollection[];
  reclaimableSize: number | null;
};

const TOP_N = 5;

export function computeInsights(collections: TaggedCollection[]): StorageInsights {
  const allIndexes: TaggedIndex[] = collections.flatMap((collection) =>
    collection.indexes.map((index) => ({
      ...index,
      database: collection.database,
      collection: collection.name,
    })),
  );

  const unused = allIndexes.filter((index) => index.ops === 0 && index.name !== '_id_');
  const reclaimable = collections
    .map((collection) => collection.freeStorageSize)
    .filter((size): size is number => size !== null);

  return {
    topCollections: [...collections]
      .sort((a, b) => b.storageSize - a.storageSize)
      .slice(0, TOP_N),
    topIndexes: [...allIndexes].sort((a, b) => b.size - a.size).slice(0, TOP_N),
    unusedIndexes: {
      items: unused,
      totalSize: unused.reduce((sum, index) => sum + index.size, 0),
    },
    indexHeavyCollections: collections.filter(
      (collection) => collection.totalIndexSize > collection.dataSize,
    ),
    reclaimableSize:
      reclaimable.length === 0 ? null : reclaimable.reduce((sum, size) => sum + size, 0),
  };
}
