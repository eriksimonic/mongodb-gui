import { Text } from '@mantine/core';
import { errorText } from '../notify-error';
import { useEffect, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { DestructiveDialog } from './DestructiveDialog';

export interface DropCollectionDialogProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly onClose: () => void;
}

/** Drops a collection after the user types its name. */
export function DropCollectionDialog({
  connectionId,
  database,
  collection,
  onClose,
}: DropCollectionDialogProps) {
  const { rpc } = useUiApi();
  return (
    <DestructiveDialog
      title={`Drop ${collection}`}
      description={`Drop ${database}.${collection}? Its documents and indexes are deleted. This cannot be undone.`}
      confirmLabel="Drop collection"
      typedConfirmation={collection}
      onConfirm={() => rpc.management.dropCollection({ connectionId, database, name: collection })}
      onClose={onClose}
    />
  );
}

export interface DropDatabaseDialogProps {
  readonly connectionId: string;
  readonly database: string;
  readonly onClose: () => void;
}

/** Drops a database and everything in it, after the user types its name. */
export function DropDatabaseDialog({ connectionId, database, onClose }: DropDatabaseDialogProps) {
  const { rpc } = useUiApi();
  return (
    <DestructiveDialog
      title={`Drop ${database}`}
      description={`Drop the database ${database}? Every collection and index in it is deleted. This cannot be undone.`}
      confirmLabel="Drop database"
      typedConfirmation={database}
      onConfirm={() => rpc.management.dropDatabase({ connectionId, database })}
      onClose={onClose}
    />
  );
}

export interface ClearCollectionDialogProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
  readonly onClose: () => void;
}

/**
 * Deletes every document in a collection. The count comes from the collection stats, so the user
 * sees what is about to go. Indexes and validation rules stay.
 */
export function ClearCollectionDialog({
  connectionId,
  database,
  collection,
  onClose,
}: ClearCollectionDialogProps) {
  const { rpc } = useUiApi();
  const [count, setCount] = useState<number | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let active = true;
    rpc.collections.stats({ connectionId, database, collection }).then(
      (stats) => {
        if (active) {
          setCount(stats.count);
        }
      },
      (failure: unknown) => {
        if (active) {
          setLoadError(errorText(failure));
        }
      },
    );
    return () => {
      active = false;
    };
  }, [rpc, connectionId, database, collection]);

  const description =
    loadError !== undefined ? (
      loadError
    ) : count === undefined ? (
      'Counting documents'
    ) : count === 0 ? (
      `${database}.${collection} is already empty.`
    ) : (
      <Text component="span" size="sm">
        Delete all {count} documents in {database}.{collection}. Indexes and validation rules stay.
        This cannot be undone.
      </Text>
    );

  return (
    <DestructiveDialog
      title={`Clear ${collection}`}
      description={description}
      confirmLabel="Clear collection"
      confirmDisabled={count === undefined || count === 0}
      onConfirm={() => rpc.management.clearCollection({ connectionId, database, name: collection })}
      onClose={onClose}
    />
  );
}
