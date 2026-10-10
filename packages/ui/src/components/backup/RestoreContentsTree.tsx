import { Badge, Checkbox, Group, Stack, Text } from '@mantine/core';
import type { BackupNamespaceInfo } from '@mongo-gui/core';
import {
  collectionsOf,
  databaseCheckState,
  databasesOf,
  isCollectionChecked,
  toggleCollection,
  toggleDatabase,
  type RestoreDraft,
} from './restore-model';

export interface RestoreContentsTreeProps {
  readonly draft: RestoreDraft;
  /** The namespaces of the backup, for the type badges and counts. */
  readonly namespaces: readonly BackupNamespaceInfo[];
  readonly onChange: (draft: RestoreDraft) => void;
}

function badgesOf(item: BackupNamespaceInfo | undefined): string[] {
  if (item === undefined) {
    return [];
  }
  return [
    ...(item.type === 'view' ? ['view'] : []),
    ...(item.type === 'timeseries' ? ['time series'] : []),
    ...(item.capped === true ? ['capped'] : []),
    ...(item.encrypted === true ? ['encrypted'] : []),
  ];
}

/** The databases and collections in the backup, each with a checkbox. */
export function RestoreContentsTree({ draft, namespaces, onChange }: RestoreContentsTreeProps) {
  return (
    <Stack gap="xs" data-testid="restore-contents">
      {databasesOf(draft).map((database) => {
        const state = databaseCheckState(draft, database);
        return (
          <Stack key={database} gap={4}>
            <Checkbox
              label={database}
              fw={500}
              checked={state === 'all'}
              indeterminate={state === 'some'}
              onChange={(event) => {
                onChange(toggleDatabase(draft, database, event.currentTarget.checked));
              }}
            />
            <Stack gap={2} pl="lg">
              {collectionsOf(draft, database).map((collection) => {
                const item = namespaces.find(
                  (entry) => entry.database === database && entry.collection === collection,
                );
                return (
                  <Group key={collection} gap="xs" wrap="nowrap">
                    <Checkbox
                      aria-label={`${database}.${collection}`}
                      label={collection}
                      checked={isCollectionChecked(draft, database, collection)}
                      onChange={(event) => {
                        onChange(
                          toggleCollection(
                            draft,
                            database,
                            collection,
                            event.currentTarget.checked,
                          ),
                        );
                      }}
                    />
                    {badgesOf(item).map((badge) => (
                      <Badge key={badge} size="xs" variant="light">
                        {badge}
                      </Badge>
                    ))}
                    {item?.documents === undefined || item.type === 'view' ? null : (
                      <Text size="xs" c="dimmed">
                        {item.documents.toLocaleString('en-US')} documents
                      </Text>
                    )}
                  </Group>
                );
              })}
            </Stack>
          </Stack>
        );
      })}
    </Stack>
  );
}
