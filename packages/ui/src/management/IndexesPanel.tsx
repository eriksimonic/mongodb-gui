import {
  Badge,
  Box,
  Button,
  Code,
  Group,
  Loader,
  Progress,
  Stack,
  Table,
  Text,
  Alert,
} from '@mantine/core';
import {
  IconAlertCircle,
  IconArrowDown,
  IconArrowUp,
  IconCopy,
  IconPlus,
  IconRefresh,
} from '@tabler/icons-react';
import { type IndexBuildProgress, type IndexInfo } from '@mongo-gui/core';
import { errorText } from '../kit/notify-error';
import { useEffect, useState } from 'react';
import { useUiApi } from '../api/ui-api';
import { useAppStore } from '../state/app-store-context';
import { formatBytes } from '../kit/input-rules';
import { runReported } from '../kit/notify-error';
import { canEditIndex } from './index-builder';
import { CreateIndexDialog } from './CreateIndexDialog';
import { ConfirmDialog } from '../kit/ConfirmDialog';

export interface CollectionPanelProps {
  readonly connectionId: string;
  readonly database: string;
  readonly collection: string;
}

const ID_INDEX = '_id_';
const BUILD_POLL_MS = 2000;
const ISO_DATE_LENGTH = 10;

/**
 * The key fields to show. The server reports a text index as `_fts: "text"` and `_ftsx: 1`, so the
 * weighted fields take the place of `_fts` and `_ftsx` is left out.
 */
function shownKeyFields(index: IndexInfo): [string, number | string][] {
  return Object.entries(index.key).flatMap(([field, value]): [string, number | string][] => {
    if (field === '_ftsx') {
      return [];
    }
    if (field === '_fts') {
      return Object.keys(index.weights ?? {}).map((weighted): [string, string] => [
        weighted,
        'text',
      ]);
    }
    return [[field, value]];
  });
}

/** Index names come from the server, so the key shows direction as an arrow and a type as a badge. */
function KeyBadges({ index }: { readonly index: IndexInfo }) {
  return (
    <Group gap={4}>
      {shownKeyFields(index).map(([field, direction]) =>
        direction === 1 || direction === -1 ? (
          <Badge
            tt="none"
            key={field}
            ff="monospace"
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

/** The locale of a collation document in EJSON, or undefined when it has none or does not parse. */
function collationLocale(collationEjson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(collationEjson);
    if (typeof parsed === 'object' && parsed !== null && 'locale' in parsed) {
      return typeof parsed.locale === 'string' ? parsed.locale : undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** The properties of an index as chips. An index with none shows a dash. */
function propertyChips(index: IndexInfo): string[] {
  const chips: string[] = [];
  const keyValues = Object.values(index.key);
  const keyFields = Object.keys(index.key);
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
  if (index.wildcardProjectionEjson !== undefined || keyFields.some((f) => f.includes('$**'))) {
    chips.push('Wildcard');
  }
  if (keyValues.includes('text')) {
    chips.push('Text');
  }
  if (keyValues.some((value) => value === '2dsphere' || value === '2d')) {
    chips.push('Geo');
  }
  if (keyValues.includes('hashed')) {
    chips.push('Hashed');
  }
  if (index.collationEjson !== undefined) {
    const locale = collationLocale(index.collationEjson);
    chips.push(locale === undefined ? 'Collation' : `Collation ${locale}`);
  }
  return chips;
}

/** The index as the server reports it, without the size and usage the panel adds. */
function definitionText(index: IndexInfo): string {
  const definition: Record<string, unknown> = { key: index.key, name: index.name };
  if (index.unique === true) {
    definition.unique = true;
  }
  if (index.sparse === true) {
    definition.sparse = true;
  }
  if (index.hidden === true) {
    definition.hidden = true;
  }
  if (index.expireAfterSeconds !== undefined) {
    definition.expireAfterSeconds = index.expireAfterSeconds;
  }
  return JSON.stringify(definition, undefined, 2);
}

function createIndexText(collection: string, index: IndexInfo): string {
  const { key, ...rest } = JSON.parse(definitionText(index)) as Record<string, unknown>;
  return `db.${collection}.createIndex(${JSON.stringify(key)}, ${JSON.stringify(rest)})`;
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <Group
      justify="space-between"
      py={6}
      style={{ borderBottom: '1px solid var(--mg-border)' }}
      wrap="nowrap"
    >
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text size="sm" ff="monospace">
        {value}
      </Text>
    </Group>
  );
}

interface IndexDetailProps {
  readonly index: IndexInfo;
  readonly database: string;
  readonly collection: string;
  readonly onEdit: () => void;
  readonly onHide: () => void;
  readonly onDrop: () => void;
}

/** The right-hand pane: usage, size, definition and the actions of one index. */
function IndexDetail({ index, database, collection, onEdit, onHide, onDrop }: IndexDetailProps) {
  const protectedIndex = index.name === ID_INDEX;
  const unused = index.usage !== undefined && index.usage.ops === 0;
  return (
    <>
      <Group gap="xs">
        <Text ff="monospace" fw={600}>
          {index.name}
        </Text>
        {propertyChips(index).map((chip) => (
          <Badge key={chip} size="xs" radius="xl" variant="light" color="gray">
            {chip}
          </Badge>
        ))}
      </Group>
      {unused && index.usage !== undefined ? (
        <Alert color="orange" variant="light" icon={<IconAlertCircle size={16} />}>
          No queries used this index since {index.usage.since.slice(0, ISO_DATE_LENGTH)}
          {index.size === undefined ? '' : `. It costs ${formatBytes(index.size)}`} and slows every
          write to {database}.{collection}.
        </Alert>
      ) : null}
      <Box>
        {index.usage === undefined ? null : (
          <>
            <DetailRow label="Accesses" value={String(index.usage.ops)} />
            <DetailRow label="Tracking since" value={index.usage.since.slice(0, ISO_DATE_LENGTH)} />
          </>
        )}
        {index.size === undefined ? null : (
          <DetailRow label="Size on disk" value={formatBytes(index.size)} />
        )}
      </Box>
      <Text size="xs" c="dimmed">
        Definition
      </Text>
      <Code block style={{ background: 'var(--mg-bg-sunken)' }}>
        {definitionText(index)}
      </Code>
      <Group gap="xs">
        <Button size="xs" variant="default" disabled={protectedIndex} onClick={onHide}>
          {index.hidden === true ? 'Unhide index' : 'Hide index'}
        </Button>
        <Button
          size="xs"
          variant="default"
          leftSection={<IconCopy size={12} />}
          onClick={() => void navigator.clipboard.writeText(createIndexText(collection, index))}
        >
          Copy createIndex
        </Button>
        <Button size="xs" variant="default" disabled={protectedIndex || !canEditIndex(index)} onClick={onEdit}>
          Edit
        </Button>
        <Button size="xs" color="red" variant="outline" disabled={protectedIndex} onClick={onDrop}>
          Drop
        </Button>
      </Group>
      <Text size="xs" c="dimmed">
        Hiding keeps the index on disk but stops the planner from using it, so you can check the
        effect before dropping.
      </Text>
    </>
  );
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
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [reloads, setReloads] = useState(0);

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
  }, [rpc, connectionId, database, collection, revision, reloads]);

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
      <Alert color="red" variant="light" m="md">
        {loadError}
      </Alert>
    );
  }
  if (indexes === undefined) {
    return <Loader size="xs" m="md" aria-label="Loading indexes" />;
  }

  const current = indexes.find((index) => index.name === selected);
  const usageSince = indexes.find((index) => index.usage !== undefined)?.usage?.since;

  return (
    <Stack gap={0} h="100%">
      <Group justify="space-between" px="md" py="sm" style={{ borderBottom: '1px solid var(--mg-border)' }}>
        <Group gap="xs">
          <Button leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
            Create index
          </Button>
          <Button
            variant="default"
            leftSection={<IconRefresh size={14} />}
            onClick={() => setReloads((count) => count + 1)}
          >
            Refresh
          </Button>
        </Group>
        <Text size="xs" c="dimmed">
          {usageSince === undefined
            ? 'No usage data'
            : `Usage from $indexStats since ${usageSince.slice(0, ISO_DATE_LENGTH)}`}
        </Text>
      </Group>

      {builds.map((build) => (
        <Stack key={`${build.indexName}:${String(build.opid)}`} gap={4} px="md" py="xs">
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

      <Group align="stretch" gap={0} wrap="nowrap" style={{ flex: 1, minHeight: 0 }}>
        <Box style={{ flex: 1, minWidth: 0, overflow: 'auto' }}>
          <Table highlightOnHover verticalSpacing="sm" fz="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th c="dimmed">Name</Table.Th>
                <Table.Th c="dimmed">Keys</Table.Th>
                <Table.Th c="dimmed">Properties</Table.Th>
                <Table.Th c="dimmed" ta="right">
                  Size
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {indexes.map((index) => {
                const chips = propertyChips(index);
                return (
                  <Table.Tr
                    key={index.name}
                    onClick={() => setSelected(index.name)}
                    style={{
                      cursor: 'pointer',
                      background:
                        index.name === selected ? 'var(--mg-surface-2)' : undefined,
                    }}
                  >
                    <Table.Td ff="monospace">{index.name}</Table.Td>
                    <Table.Td>
                      <KeyBadges index={index} />
                    </Table.Td>
                    <Table.Td>
                      <Group gap={4}>
                        {chips.map((chip) => (
                          <Badge
                            key={chip}
                            size="xs"
                            radius="xl"
                            variant="light"
                            color="gray"
                            styles={{ root: { textTransform: 'uppercase', fontWeight: 500 } }}
                          >
                            {chip}
                          </Badge>
                        ))}
                      </Group>
                    </Table.Td>
                    <Table.Td ta="right" ff="monospace">
                      {index.size === undefined ? (
                        <Text size="xs" c="dimmed">
                          unknown
                        </Text>
                      ) : (
                        formatBytes(index.size)
                      )}
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Box>
        <Stack
          gap="sm"
          p="md"
          w={340}
          aria-label="Index details"
          role="region"
          style={{ borderLeft: '1px solid var(--mg-border)', overflow: 'auto', flexShrink: 0 }}
        >
          {current === undefined ? (
            <Text size="sm" c="dimmed">
              Select an index to see its details.
            </Text>
          ) : (
            <IndexDetail
              index={current}
              database={database}
              collection={collection}
              onEdit={() => setEditing(current)}
              onHide={() => setHidden(current, current.hidden !== true)}
              onDrop={() => setDropping(current)}
            />
          )}
        </Stack>
      </Group>

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
        <ConfirmDialog
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
