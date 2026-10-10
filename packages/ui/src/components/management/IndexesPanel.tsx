import { Badge, Button, Group, Loader, Progress, Stack, Table, Text, Alert } from '@mantine/core';
import { IconArrowDown, IconArrowUp, IconPlus } from '@tabler/icons-react';
import { type IndexBuildProgress, type IndexInfo } from '@mongo-gui/core';
import { errorText } from '../notify-error';
import { useEffect, useState } from 'react';
import { useUiApi } from '../../api/ui-api';
import { useAppStore } from '../../state/app-store-context';
import { formatBytes } from '../../management/input-rules';
import { runReported } from '../notify-error';
import { canEditIndex } from '../../management/index-builder';
import { CreateIndexDialog } from './CreateIndexDialog';
import { DestructiveDialog } from './DestructiveDialog';

export interface CollectionPanelProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

const ID_INDEX = '_id_';
const BUILD_POLL_MS = 2000;
const ISO_DATE_LENGTH = 10;

/** Index names come from the server, so the key shows direction as an arrow and a type as a badge. */
function KeyBadges({ index }: { readonly index: IndexInfo }) {
  return (
    <Group gap={4}>
      {Object.entries(index.key).map(([field, direction]) =>
        direction === 1 || direction === -1 ? (
          <Badge
            tt="none"
            key={field}
            variant="outline"
            color="gray"
            leftSection={
              direction === 1 ? (
                <IconArrowUp size={12} aria-label="ascending" />
              ) : (
                <IconArrowDown size={12} aria-label="descending" />
              )
            }
          >
            {field}
          </Badge>
        ) : (
          <Badge tt="none" key={field} variant="outline" color="gray">
            {field}{' '}
            <Text component="span" size="xs" c="violet" ml={4}>
              {String(direction)}
            </Text>
          </Badge>
        ),
      )}
    </Group>
  );
}

/** The properties of an index as chips. An index with none shows a dash. */
function propertyChips(index: IndexInfo): string[] {
  const chips: string[] = [];
  if (index.unique === true) {
    chips.push('Unique');
  }
  if (index.sparse === true) {
    chips.push('Sparse');
  }
  if (index.hidden === true) {
    chips.push('Hidden');
  }
  if (index.expireAfterSeconds !== undefined) {
    chips.push(`TTL ${index.expireAfterSeconds} s`);
  }
  if (index.partialFilterExpressionEjson !== undefined) {
    chips.push('Partial');
  }
  if (index.wildcardProjectionEjson !== undefined) {
    chips.push('Wildcard');
  }
  if (Object.values(index.key).includes('text')) {
    chips.push('Text');
  }
  return chips;
}

function usageText(index: IndexInfo): string {
  if (index.usage === undefined) {
    return 'No usage data';
  }
  return `${index.usage.ops} ops since ${index.usage.since.slice(0, ISO_DATE_LENGTH)}`;
}

/** Lists the indexes of one collection, shows builds in progress, and creates, hides and drops indexes. */
export function IndexesPanel({ connectionId, database, collection }: CollectionPanelProps) {
  const { rpc } = useUiApi();
  const revision = useAppStore((state) => state.catalogRevision);
  const [indexes, setIndexes] = useState<IndexInfo[] | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [builds, setBuilds] = useState<IndexBuildProgress[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<IndexInfo | undefined>(undefined);
  const [dropping, setDropping] = useState<IndexInfo | undefined>(undefined);

  useEffect(() => {
    let active = true;
    rpc.collections.indexes({ connectionId, database, collection }).then(
      (list) => {
        if (active) {
          setIndexes(list);
          setLoadError(undefined);
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
  }, [rpc, connectionId, database, collection, revision]);

  // A build can start or finish at any time, so the rows are polled while the panel is open.
  useEffect(() => {
    let active = true;
    function poll() {
      rpc.management.listIndexBuilds({ connectionId, database }).then(
        (rows) => {
          if (active) {
            setBuilds(rows.filter((row) => row.collection === collection));
          }
        },
        () => {
          // A failed poll keeps the last rows. The next tick tries again.
        },
      );
    }
    poll();
    const timer = setInterval(poll, BUILD_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [rpc, connectionId, database, collection]);

  function setHidden(index: IndexInfo, hidden: boolean) {
    void runReported(() =>
      rpc.management.setIndexHidden({
        connectionId,
        database,
        collection,
        name: index.name,
        hidden,
      }),
    );
  }

  if (loadError !== undefined) {
    return (
      <Alert color="red" variant="light" m="sm">
        {loadError}
      </Alert>
    );
  }
  if (indexes === undefined) {
    return <Loader size="xs" m="sm" aria-label="Loading indexes" />;
  }

  return (
    <Stack gap="sm" p="sm">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          {indexes.length} {indexes.length === 1 ? 'index' : 'indexes'} on {database}.{collection}
        </Text>
        <Button leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
          Create index
        </Button>
      </Group>

      {builds.map((build) => (
        <Stack key={`${build.indexName}:${String(build.opid)}`} gap={4}>
          <Text size="xs">
            Building {build.indexName}. {build.phase}
            {build.progressPercent === undefined ? '' : ` ${build.progressPercent}%`}
          </Text>
          <Progress
            value={build.progressPercent ?? 0}
            animated={build.progressPercent === undefined}
            size="sm"
            aria-label={`Build of ${build.indexName}`}
          />
        </Stack>
      ))}

      <Table striped highlightOnHover withTableBorder verticalSpacing="xs" fz="sm">
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Name</Table.Th>
            <Table.Th>Keys</Table.Th>
            <Table.Th>Properties</Table.Th>
            <Table.Th>Size</Table.Th>
            <Table.Th>Usage</Table.Th>
            <Table.Th>Actions</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {indexes.map((index) => {
            const protectedIndex = index.name === ID_INDEX;
            const chips = propertyChips(index);
            return (
              <Table.Tr key={index.name}>
                <Table.Td>{index.name}</Table.Td>
                <Table.Td>
                  <KeyBadges index={index} />
                </Table.Td>
                <Table.Td>
                  {chips.length === 0 ? (
                    <Text size="xs" c="dimmed">
                      None
                    </Text>
                  ) : (
                    <Group gap={4}>
                      {chips.map((chip) => (
                        <Badge tt="none" key={chip} size="xs" variant="light">
                          {chip}
                        </Badge>
                      ))}
                    </Group>
                  )}
                </Table.Td>
                <Table.Td>{formatBytes(index.size ?? 0)}</Table.Td>
                <Table.Td>
                  <Text size="xs">{usageText(index)}</Text>
                </Table.Td>
                <Table.Td>
                  <Group gap={4} wrap="nowrap">
                    <Button
                      size="xs"
                      variant="default"
                      disabled={protectedIndex || !canEditIndex(index)}
                      onClick={() => setEditing(index)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="xs"
                      variant="default"
                      disabled={protectedIndex}
                      onClick={() => setHidden(index, index.hidden !== true)}
                    >
                      {index.hidden === true ? 'Unhide' : 'Hide'}
                    </Button>
                    <Button
                      size="xs"
                      color="red"
                      variant="light"
                      disabled={protectedIndex}
                      onClick={() => setDropping(index)}
                    >
                      Drop
                    </Button>
                  </Group>
                </Table.Td>
              </Table.Tr>
            );
          })}
        </Table.Tbody>
      </Table>

      {creating ? (
        <CreateIndexDialog
          connectionId={connectionId}
          database={database}
          collection={collection}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editing === undefined ? null : (
        <CreateIndexDialog
          connectionId={connectionId}
          database={database}
          collection={collection}
          editing={editing}
          onClose={() => setEditing(undefined)}
        />
      )}
      {dropping === undefined ? null : (
        <DestructiveDialog
          title={`Drop index ${dropping.name}`}
          description={`Drop the index ${dropping.name} on ${database}.${collection}? Queries that used it fall back to other indexes or a scan.`}
          confirmLabel="Drop index"
          typedConfirmation={dropping.name}
          onConfirm={() =>
            rpc.management.dropIndex({
              connectionId,
              database,
              collection,
              name: dropping.name,
            })
          }
          onClose={() => setDropping(undefined)}
        />
      )}
    </Stack>
  );
}
