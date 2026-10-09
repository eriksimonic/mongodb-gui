import { Stack } from '@mantine/core';
import { IconDatabase } from '@tabler/icons-react';
import { useEffect } from 'react';
import type { Loadable } from '../../state/app-store';
import { useAppStore } from '../../state/app-store-context';
import { catalogKey, databaseNodeId } from '../../state/node-ids';
import { CollectionIcon } from './CollectionIcon';
import { TreeMessage, TreeRow } from './TreeRow';
import type { CollectionInfo } from '@mongo-gui/core';

export interface DatabaseNodeProps {
  readonly connectionId: string;
  readonly database: string;
  readonly depth: number;
}

/** A database in the tree. Expanding it loads its collections. */
export function DatabaseNode({ connectionId, database, depth }: DatabaseNodeProps) {
  const nodeId = databaseNodeId(connectionId, database);
  const key = catalogKey(connectionId, database);
  const expanded = useAppStore((state) => state.expanded[nodeId] === true);
  const collections = useAppStore((state) => state.collections[key]);
  const selected = useAppStore(
    (state) =>
      state.selection?.connectionId === connectionId &&
      state.selection.database === database &&
      state.selection.collection === undefined,
  );
  const setNodeExpanded = useAppStore((state) => state.setNodeExpanded);
  const loadCollections = useAppStore((state) => state.loadCollections);
  const select = useAppStore((state) => state.select);

  useEffect(() => {
    if (expanded && collections === undefined) {
      void loadCollections(connectionId, database);
    }
  }, [expanded, collections, connectionId, database, loadCollections]);

  return (
    <Stack gap={0}>
      <TreeRow
        depth={depth}
        label={database}
        icon={<IconDatabase size={14} aria-label="Database" />}
        expandable
        expanded={expanded}
        selected={selected}
        onToggle={() => setNodeExpanded(nodeId, !expanded)}
        onSelect={() => select({ connectionId, database })}
      />
      {expanded ? (
        <CollectionChildren
          connectionId={connectionId}
          database={database}
          depth={depth + 1}
          collections={collections}
        />
      ) : null}
    </Stack>
  );
}

interface CollectionChildrenProps {
  readonly connectionId: string;
  readonly database: string;
  readonly depth: number;
  readonly collections: Loadable<readonly CollectionInfo[]> | undefined;
}

function CollectionChildren({
  connectionId,
  database,
  depth,
  collections,
}: CollectionChildrenProps) {
  const select = useAppStore((state) => state.select);
  const selectedCollection = useAppStore((state) =>
    state.selection?.connectionId === connectionId && state.selection.database === database
      ? state.selection.collection
      : undefined,
  );

  if (collections === undefined || collections.state === 'loading') {
    return <TreeMessage depth={depth}>Loading collections</TreeMessage>;
  }
  if (collections.state === 'error') {
    return (
      <TreeMessage depth={depth} tone="red">
        {collections.error.message}
      </TreeMessage>
    );
  }
  if (collections.data.length === 0) {
    return <TreeMessage depth={depth}>No collections</TreeMessage>;
  }
  return (
    <Stack gap={0}>
      {collections.data.map((collection) => (
        <TreeRow
          key={collection.name}
          depth={depth}
          label={collection.name}
          icon={<CollectionIcon type={collection.type} />}
          selected={selectedCollection === collection.name}
          onSelect={() => select({ connectionId, database, collection: collection.name })}
        />
      ))}
    </Stack>
  );
}
