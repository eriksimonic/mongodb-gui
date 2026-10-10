import { Button, Group, Progress, Table, Text } from '@mantine/core';
import {
  shardKeyText,
  type ShardedCollection,
  type ShardedDatabase,
  type ShardInfo,
  type ZoneInfo,
} from '@mongo-gui/core';

/** Databases the server keeps for itself. Sharding them is refused, so the table says so. */
const RESERVED_DATABASES: readonly string[] = ['admin', 'config', 'local'];

/** One colour per shard, in the order the overview lists the shards. */
const SHARD_COLOURS = ['blue', 'teal', 'grape', 'orange', 'cyan', 'pink'] as const;

function colourOf(shards: readonly ShardInfo[], shard: string): string {
  const index = shards.findIndex((item) => item.id === shard);
  return SHARD_COLOURS[index % SHARD_COLOURS.length] ?? 'blue';
}

export interface ShardsTableProps {
  readonly shards: readonly ShardInfo[];
}

export function ShardsTable({ shards }: ShardsTableProps) {
  if (shards.length === 0) {
    return <Text size="sm">No shards are registered.</Text>;
  }
  return (
    <Table striped withTableBorder>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Shard</Table.Th>
          <Table.Th>Host</Table.Th>
          <Table.Th>State</Table.Th>
          <Table.Th>Tags</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {shards.map((shard) => (
          <Table.Tr key={shard.id}>
            <Table.Td>{shard.id}</Table.Td>
            <Table.Td>{shard.host}</Table.Td>
            <Table.Td>{shard.draining === true ? 'Draining' : 'Active'}</Table.Td>
            <Table.Td>{shard.tags.length === 0 ? '-' : shard.tags.join(', ')}</Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export interface DatabasesTableProps {
  readonly databases: readonly ShardedDatabase[];
  readonly onEnable: (database: string) => void;
}

export function DatabasesTable({ databases, onEnable }: DatabasesTableProps) {
  return (
    <Table striped withTableBorder>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Database</Table.Th>
          <Table.Th>Primary shard</Table.Th>
          <Table.Th>Sharded</Table.Th>
          <Table.Th>Action</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {databases.map((database) => {
          const reserved = RESERVED_DATABASES.includes(database.name);
          return (
            <Table.Tr key={database.name}>
              <Table.Td>{database.name}</Table.Td>
              <Table.Td>{database.primaryShard === '' ? '-' : database.primaryShard}</Table.Td>
              <Table.Td>{database.partitioned ? 'Yes' : 'No'}</Table.Td>
              <Table.Td>
                {database.partitioned ? null : reserved ? (
                  <Text size="xs" c="dimmed">
                    Reserved by the server
                  </Text>
                ) : (
                  <Button size="xs" variant="default" onClick={() => onEnable(database.name)}>
                    Enable sharding
                  </Button>
                )}
              </Table.Td>
            </Table.Tr>
          );
        })}
      </Table.Tbody>
    </Table>
  );
}

export interface CollectionsTableProps {
  readonly collections: readonly ShardedCollection[];
  readonly shards: readonly ShardInfo[];
  readonly onDistribution: (namespace: string) => void;
}

/** Chunks per shard as one bar and a text line, so a colour alone does not carry the numbers. */
function ChunkBar({
  collection,
  shards,
}: {
  collection: ShardedCollection;
  shards: readonly ShardInfo[];
}) {
  const entries = shards.map((shard) => ({
    shard: shard.id,
    chunks: collection.chunksPerShard[shard.id] ?? 0,
  }));
  const total = entries.reduce((sum, item) => sum + item.chunks, 0);
  const sections = entries.map((item) => ({
    value: total === 0 ? 0 : (item.chunks / total) * 100,
    color: colourOf(shards, item.shard),
  }));
  return (
    <Group gap="xs" wrap="nowrap" style={{ minWidth: 220 }}>
      <Progress.Root size="sm" w={120} aria-label={`Chunks of ${collection.ns} per shard`}>
        {sections.map((section, index) => (
          <Progress.Section
            key={entries[index]?.shard}
            value={section.value}
            color={section.color}
          />
        ))}
      </Progress.Root>
      <Text size="xs" c="dimmed">
        {entries.map((item) => `${item.shard} ${item.chunks}`).join(', ')}
      </Text>
    </Group>
  );
}

export function CollectionsTable({ collections, shards, onDistribution }: CollectionsTableProps) {
  if (collections.length === 0) {
    return <Text size="sm">No collection is sharded.</Text>;
  }
  return (
    <Table striped withTableBorder>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Collection</Table.Th>
          <Table.Th>Shard key</Table.Th>
          <Table.Th>Unique</Table.Th>
          <Table.Th>Chunks per shard</Table.Th>
          <Table.Th>Documents</Table.Th>
          <Table.Th>Action</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {collections.map((collection) => (
          <Table.Tr key={collection.ns}>
            <Table.Td>{collection.ns}</Table.Td>
            <Table.Td>
              <Text size="xs" ff="monospace">
                {shardKeyText(collection.key)}
              </Text>
            </Table.Td>
            <Table.Td>{collection.unique ? 'Yes' : 'No'}</Table.Td>
            <Table.Td>
              <ChunkBar collection={collection} shards={shards} />
            </Table.Td>
            <Table.Td>{collection.docCount ?? '-'}</Table.Td>
            <Table.Td>
              <Button size="xs" variant="default" onClick={() => onDistribution(collection.ns)}>
                Distribution
              </Button>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}

export interface ZonesTableProps {
  readonly zones: readonly ZoneInfo[];
}

export function ZonesTable({ zones }: ZonesTableProps) {
  const rows = zones.flatMap((zone) =>
    zone.ranges.length === 0
      ? [{ zone: zone.zone, shards: zone.shards, ns: '-', range: '-' }]
      : zone.ranges.map((range) => ({
          zone: zone.zone,
          shards: zone.shards,
          ns: range.ns,
          range: `${JSON.stringify(range.min)} to ${JSON.stringify(range.max)}`,
        })),
  );
  if (rows.length === 0) {
    return <Text size="sm">No zones are defined.</Text>;
  }
  return (
    <Table striped withTableBorder>
      <Table.Thead>
        <Table.Tr>
          <Table.Th>Zone</Table.Th>
          <Table.Th>Shards</Table.Th>
          <Table.Th>Collection</Table.Th>
          <Table.Th>Range</Table.Th>
        </Table.Tr>
      </Table.Thead>
      <Table.Tbody>
        {rows.map((row) => (
          <Table.Tr key={`${row.zone}-${row.ns}-${row.range}`}>
            <Table.Td>{row.zone}</Table.Td>
            <Table.Td>{row.shards.length === 0 ? '-' : row.shards.join(', ')}</Table.Td>
            <Table.Td>{row.ns}</Table.Td>
            <Table.Td>
              <Text size="xs" ff="monospace">
                {row.range}
              </Text>
            </Table.Td>
          </Table.Tr>
        ))}
      </Table.Tbody>
    </Table>
  );
}
